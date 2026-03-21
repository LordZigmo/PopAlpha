// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "PopAlphaCore",
    platforms: [
        .iOS(.v17)
    ],
    products: [
        .library(
            name: "PopAlphaCore",
            targets: ["PopAlphaCore"]
        )
    ],
    targets: [
        .target(
            name: "PopAlphaCore",
            path: "Sources/Features/Scanner",
            exclude: [
                ".DS_Store",
                "ai_env",
                "training_logs",
                "training_runs"
            ],
            resources: [
                .process("Resources")
            ]
        )
    ]
)
