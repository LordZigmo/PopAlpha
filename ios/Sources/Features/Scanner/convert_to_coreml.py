#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import coremltools as ct
import torch
import torch.nn.functional as F
from torch import nn

from rfdetr import RFDETRBase, RFDETRLarge, RFDETRMedium, RFDETRNano, RFDETRSmall

MODEL_NAME = "PopAlphaRFDETRLive"
PROBABILITIES_OUTPUT_NAME = "class_scores"
PREDICTED_FEATURE_NAME = "cardID"

VARIANT_TYPES = {
    "base": RFDETRBase,
    "large": RFDETRLarge,
    "medium": RFDETRMedium,
    "nano": RFDETRNano,
    "small": RFDETRSmall,
}

DEFAULT_RESOLUTIONS = {
    "base": 560,
    "large": 560,
    "medium": 576,
    "nano": 384,
    "small": 512,
}


@dataclass(frozen=True)
class FileSnapshot:
    modified_ns: int
    size: int


class RFDETRBackboneClassifierWrapper(nn.Module):
    def __init__(
        self,
        backbone: nn.Module,
        class_embed: nn.Module,
        object_class_count: int,
    ) -> None:
        super().__init__()
        self.backbone = backbone
        self.class_embed = class_embed
        self.object_class_count = object_class_count
        self.register_buffer(
            "mean",
            torch.tensor([0.485, 0.456, 0.406], dtype=torch.float32).view(1, 3, 1, 1),
        )
        self.register_buffer(
            "std",
            torch.tensor([0.229, 0.224, 0.225], dtype=torch.float32).view(1, 3, 1, 1),
        )

    def forward(self, image: torch.Tensor) -> torch.Tensor:
        normalized = (image - self.mean) / self.std
        features, _, _ = self.backbone(normalized)
        pooled = features[-1].mean(dim=(-2, -1))
        logits = F.linear(
            pooled,
            self.class_embed.weight[: self.object_class_count],
            self.class_embed.bias[: self.object_class_count],
        )
        return logits.sigmoid().squeeze(0)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert an RF-DETR checkpoint into a Core ML package for the scanner."
    )
    parser.add_argument(
        "--checkpoint",
        type=Path,
        required=True,
        help="Path to checkpoint.pth, checkpoint_best_regular.pth, or checkpointXXXX.pth.",
    )
    parser.add_argument(
        "--annotations",
        type=Path,
        default=Path("pokemon_card_detector-1/train/_annotations.coco.json"),
        help="COCO annotations used to recover class label ordering.",
    )
    parser.add_argument(
        "--variant",
        choices=sorted(VARIANT_TYPES.keys()),
        default="base",
        help="RF-DETR architecture used for training.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("ios/Sources/Features/Scanner/Resources/Models"),
        help="Directory that will receive the .mlpackage resource.",
    )
    parser.add_argument(
        "--model-name",
        default=MODEL_NAME,
        help="Output Core ML model name, without extension.",
    )
    parser.add_argument(
        "--deployment-target",
        default="iOS17",
        choices=["iOS17", "iOS18"],
        help="Minimum iOS deployment target for the generated mlprogram.",
    )
    parser.add_argument(
        "--watch",
        action="store_true",
        help="Poll the checkpoint path for updates and re-export the model each time it changes.",
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=15.0,
        help="Seconds between checkpoint/log polling cycles when --watch is enabled.",
    )
    parser.add_argument(
        "--log-file",
        type=Path,
        default=None,
        help="Training log file to monitor for average-loss notifications. Defaults to <checkpoint dir>/log.txt.",
    )
    parser.add_argument(
        "--loss-threshold",
        type=float,
        default=3.0,
        help="Trigger a macOS success notification once train_loss drops below this value.",
    )
    parser.add_argument(
        "--disable-notifications",
        action="store_true",
        help="Disable the macOS success notification even when the loss threshold is met.",
    )
    return parser.parse_args()


def load_checkpoint(checkpoint_path: Path) -> dict:
    if not checkpoint_path.is_file():
        raise FileNotFoundError(f"Checkpoint not found: {checkpoint_path}")

    return torch.load(checkpoint_path, map_location="cpu", weights_only=False)


def resolve_class_names(
    checkpoint: dict,
    annotations_path: Path,
    expected_class_count: int | None = None,
) -> list[str]:
    checkpoint_args = checkpoint.get("args")
    class_names = getattr(checkpoint_args, "class_names", None)
    if class_names:
        names = [str(name) for name in class_names]
        if expected_class_count is None or len(names) == expected_class_count:
            return names

    if not annotations_path.is_file():
        raise FileNotFoundError(
            f"Unable to recover class names: annotations file not found at {annotations_path}"
        )

    annotations = json.loads(annotations_path.read_text())
    categories = sorted(
        annotations.get("categories", []),
        key=lambda category: int(category["id"]),
    )
    names = [str(category["name"]) for category in categories]
    if expected_class_count is not None and len(names) != expected_class_count:
        raise ValueError(
            f"Expected {expected_class_count} class names but found {len(names)} in {annotations_path}"
        )

    return names


def resolve_resolution(checkpoint: dict, fallback: int) -> int:
    checkpoint_args = checkpoint.get("args")
    resolution = getattr(checkpoint_args, "resolution", None)
    if resolution is None:
        return fallback

    return int(resolution)


def build_detector(
    variant: str,
    checkpoint_path: Path,
    checkpoint: dict,
    constructor_num_classes: int,
) -> tuple[nn.Module, int]:
    detector_type = VARIANT_TYPES[variant]
    resolution = resolve_resolution(checkpoint, fallback=DEFAULT_RESOLUTIONS[variant])
    detector = detector_type(
        num_classes=constructor_num_classes,
        pretrain_weights=str(checkpoint_path),
        device="cpu",
        resolution=resolution,
    )
    detector.model.model.backbone.export()
    detector.model.model = detector.model.model.cpu().eval()
    return detector.model.model, resolution


def convert_to_coreml(
    wrapped_model: nn.Module,
    resolution: int,
    class_names: Sequence[str],
    output_path: Path,
    deployment_target: str,
) -> Path:
    wrapped_model.eval()
    example_input = torch.rand(1, 3, resolution, resolution, dtype=torch.float32)
    traced_model = torch.jit.trace(wrapped_model, example_input, strict=False)

    minimum_target = {
        "iOS17": ct.target.iOS17,
        "iOS18": ct.target.iOS18,
    }[deployment_target]

    mlmodel = ct.convert(
        traced_model,
        source="pytorch",
        convert_to="mlprogram",
        inputs=[
            ct.ImageType(
                name="image",
                shape=example_input.shape,
                scale=1 / 255.0,
                color_layout=ct.colorlayout.RGB,
            )
        ],
        outputs=[ct.TensorType(name=PROBABILITIES_OUTPUT_NAME)],
        classifier_config=ct.ClassifierConfig(
            list(class_names),
            predicted_feature_name=PREDICTED_FEATURE_NAME,
            predicted_probabilities_output=PROBABILITIES_OUTPUT_NAME,
        ),
        minimum_deployment_target=minimum_target,
        compute_precision=ct.precision.FLOAT16,
        compute_units=ct.ComputeUnit.CPU_AND_NE,
    )

    mlmodel.author = "PopAlpha"
    mlmodel.short_description = (
        "RF-DETR backbone smoke-test classifier exported for Apple Neural Engine execution."
    )
    mlmodel.license = "Internal"
    mlmodel.input_description["image"] = "RGB scanner frame."

    output_feature_names = [
        feature.name for feature in mlmodel.get_spec().description.output
    ]
    if PREDICTED_FEATURE_NAME in output_feature_names:
        mlmodel.output_description[PREDICTED_FEATURE_NAME] = "Top scanner class label."
    for output_name in output_feature_names:
        if output_name != PREDICTED_FEATURE_NAME:
            mlmodel.output_description[output_name] = "Per-class confidence scores."

    mlmodel.user_defined_metadata["com.popalpha.model.variant"] = "rf-detr"
    mlmodel.user_defined_metadata["com.popalpha.model.classLabels"] = json.dumps(list(class_names))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.is_dir():
        shutil.rmtree(output_path)
    elif output_path.exists():
        output_path.unlink()

    mlmodel.save(str(output_path))
    return output_path


def export_checkpoint(args: argparse.Namespace) -> Path:
    checkpoint = load_checkpoint(args.checkpoint)
    class_names = resolve_class_names(checkpoint, args.annotations)
    object_class_count = len(class_names)
    if object_class_count <= 0:
        raise ValueError("Checkpoint does not contain any object classes to export.")

    checkpoint_class_count = checkpoint["model"]["class_embed.bias"].shape[0]
    constructor_num_classes = max(checkpoint_class_count - 1, 0)
    if object_class_count > checkpoint_class_count:
        raise ValueError(
            "Checkpoint class head does not match the recovered class label count."
        )

    detector_model, resolution = build_detector(
        args.variant,
        args.checkpoint,
        checkpoint,
        constructor_num_classes,
    )
    wrapped_model = RFDETRBackboneClassifierWrapper(
        backbone=detector_model.backbone,
        class_embed=detector_model.class_embed,
        object_class_count=object_class_count,
    )

    output_path = args.output_dir / f"{args.model_name}.mlpackage"
    saved_path = convert_to_coreml(
        wrapped_model=wrapped_model,
        resolution=resolution,
        class_names=class_names,
        output_path=output_path,
        deployment_target=args.deployment_target,
    )
    print(saved_path)
    return saved_path


def snapshot_file(path: Path) -> FileSnapshot | None:
    if not path.is_file():
        return None

    stat_result = path.stat()
    return FileSnapshot(
        modified_ns=stat_result.st_mtime_ns,
        size=stat_result.st_size,
    )


def read_log_records(log_path: Path, offset: int) -> tuple[int, list[dict]]:
    if not log_path.exists():
        return offset, []

    log_size = log_path.stat().st_size
    if offset > log_size:
        offset = 0

    records: list[dict] = []
    with log_path.open("r", encoding="utf-8") as handle:
        handle.seek(offset)
        while True:
            line = handle.readline()
            if not line:
                break
            stripped = line.strip()
            if not stripped:
                continue
            try:
                records.append(json.loads(stripped))
            except json.JSONDecodeError:
                continue
        new_offset = handle.tell()

    return new_offset, records


def training_loss(record: dict) -> float | None:
    value = record.get("train_loss")
    if value is None:
        return None

    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def log_file_path(args: argparse.Namespace) -> Path:
    if args.log_file is not None:
        return args.log_file

    return args.checkpoint.parent / "log.txt"


def notify_success(
    average_loss: float,
    checkpoint_path: Path,
    output_path: Path,
) -> None:
    if sys.platform != "darwin":
        return

    title = "PopAlpha Training"
    subtitle = f"Average loss dropped below target: {average_loss:.3f}"
    body = (
        f"Updated {output_path.name} from {checkpoint_path.name}. "
        "The scanner smoke-test model is refreshed."
    )

    script = (
        f"display notification {apple_script_string(body)} "
        f"with title {apple_script_string(title)} "
        f"subtitle {apple_script_string(subtitle)} "
        'sound name "Glass"'
    )

    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        stderr = result.stderr.strip()
        if stderr:
            print(f"Notification failed: {stderr}", file=sys.stderr)


def apple_script_string(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def watch_checkpoint(args: argparse.Namespace) -> None:
    checkpoint_path = args.checkpoint
    log_path = log_file_path(args)
    output_path = args.output_dir / f"{args.model_name}.mlpackage"
    last_exported_snapshot: FileSnapshot | None = None
    notified_below_threshold = False
    log_offset = 0

    log_offset, existing_records = read_log_records(log_path, log_offset)
    notified_below_threshold = any(
        (loss is not None and loss < args.loss_threshold)
        for loss in (training_loss(record) for record in existing_records)
    )

    print(
        f"Watching {checkpoint_path} every {args.poll_interval:.1f}s "
        f"and monitoring {log_path} for train_loss < {args.loss_threshold:.3f}."
    )

    while True:
        checkpoint_snapshot = snapshot_file(checkpoint_path)
        if checkpoint_snapshot is not None and checkpoint_snapshot != last_exported_snapshot:
            try:
                saved_path = export_checkpoint(args)
                last_exported_snapshot = checkpoint_snapshot
                print(
                    f"Refreshed {saved_path.name} from {checkpoint_path.name} "
                    f"at {time.strftime('%Y-%m-%d %H:%M:%S')}."
                )
            except Exception as error:  # noqa: BLE001
                print(
                    f"Checkpoint refresh failed for {checkpoint_path.name}: {error}",
                    file=sys.stderr,
                )

        log_offset, new_records = read_log_records(log_path, log_offset)
        if not args.disable_notifications and not notified_below_threshold:
            for record in new_records:
                average_loss = training_loss(record)
                if average_loss is None or average_loss >= args.loss_threshold:
                    continue

                notify_success(
                    average_loss=average_loss,
                    checkpoint_path=checkpoint_path,
                    output_path=output_path,
                )
                notified_below_threshold = True
                break

        time.sleep(args.poll_interval)


def main() -> None:
    args = parse_args()
    if args.watch:
        watch_checkpoint(args)
        return

    export_checkpoint(args)


if __name__ == "__main__":
    torch.set_grad_enabled(False)
    main()
