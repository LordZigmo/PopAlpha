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
                "ai_env"
            ],
            resources: [
                .process("Resources/Catalog/siglip2_catalog_v1.papb"),
                .process("Resources/Models/PopAlphaRFDETRLive.mlpackage"),
                .process("Resources/Models/siglip2_base_patch16_384.mlpackage"),
                .process("Resources/mock_cards.json")
            ]
        )
    ]
)
