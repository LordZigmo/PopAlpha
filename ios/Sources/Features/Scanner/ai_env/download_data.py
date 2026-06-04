import os

from roboflow import Roboflow

# Initialize with your key from the environment — never hardcode it.
# Set ROBOFLOW_API_KEY before running: `export ROBOFLOW_API_KEY=...`
api_key = os.environ.get("ROBOFLOW_API_KEY")
if not api_key:
    raise SystemExit("Set the ROBOFLOW_API_KEY environment variable before running.")
rf = Roboflow(api_key=api_key)

# NOTE: You need to replace these placeholders with your actual IDs 
# You can find these in the URL of your Roboflow project page
# Example: universe.roboflow.com/workspace-id/project-id/version
project = rf.workspace("object-detection-ggkai").project("pokemon_card_detector-aad0t")
dataset = project.version(1).download("coco")

print(f"Dataset downloaded to: {dataset.location}")