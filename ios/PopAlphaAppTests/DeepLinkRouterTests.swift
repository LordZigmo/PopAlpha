import XCTest
@testable import PopAlphaApp

/// Covers the URL → Destination parsing in DeepLinkRouter. These are
/// pure-logic tests — no network, no simulator state, no view tree.
/// They run in milliseconds and catch regressions in the most
/// security-relevant piece of the Universal Links pipeline (host
/// allowlisting + path classification).
@MainActor
final class DeepLinkRouterTests: XCTestCase {
    /// DeepLinkRouter is a singleton with private init. Reset state
    /// between tests by consuming any leftover destination so each
    /// test starts from a clean slate.
    override func setUp() async throws {
        try await super.setUp()
        DeepLinkRouter.shared.consume()
    }

    // MARK: - Happy paths

    func testHandlesCardURL() throws {
        let url = try XCTUnwrap(URL(string: "https://popalpha.ai/c/charizard-base-set-4"))

        let didRoute = DeepLinkRouter.shared.handle(url: url)

        XCTAssertTrue(didRoute)
        XCTAssertEqual(
            DeepLinkRouter.shared.pendingDestination,
            .card(slug: "charizard-base-set-4")
        )
    }

    func testHandlesSetURL() throws {
        let url = try XCTUnwrap(URL(string: "https://popalpha.ai/sets/jungle"))

        let didRoute = DeepLinkRouter.shared.handle(url: url)

        XCTAssertTrue(didRoute)
        XCTAssertEqual(
            DeepLinkRouter.shared.pendingDestination,
            .set(name: "jungle")
        )
    }

    func testHandlesCardURLWithQueryParams() throws {
        // Query strings should be ignored — only the path matters for
        // routing. Real share links sometimes have utm_* params.
        let url = try XCTUnwrap(URL(string: "https://popalpha.ai/c/pikachu-base-set-25?utm_source=imessage"))

        let didRoute = DeepLinkRouter.shared.handle(url: url)

        XCTAssertTrue(didRoute)
        XCTAssertEqual(
            DeepLinkRouter.shared.pendingDestination,
            .card(slug: "pikachu-base-set-25")
        )
    }

    func testHostMatchIsCaseInsensitive() throws {
        // Email clients sometimes normalize hosts to uppercase.
        let url = try XCTUnwrap(URL(string: "https://POPALPHA.AI/c/mew-promos-8"))

        let didRoute = DeepLinkRouter.shared.handle(url: url)

        XCTAssertTrue(didRoute)
        XCTAssertEqual(
            DeepLinkRouter.shared.pendingDestination,
            .card(slug: "mew-promos-8")
        )
    }

    // MARK: - Rejected paths

    func testRejectsNonPopalphaHost() throws {
        let url = try XCTUnwrap(URL(string: "https://example.com/c/charizard"))

        let didRoute = DeepLinkRouter.shared.handle(url: url)

        XCTAssertFalse(didRoute)
        XCTAssertNil(DeepLinkRouter.shared.pendingDestination)
    }

    func testRejectsRootPath() throws {
        let url = try XCTUnwrap(URL(string: "https://popalpha.ai/"))

        let didRoute = DeepLinkRouter.shared.handle(url: url)

        XCTAssertFalse(didRoute)
        XCTAssertNil(DeepLinkRouter.shared.pendingDestination)
    }

    func testRejectsUnknownTopLevelPath() throws {
        // Subdomains, admin pages, settings — anything not in the AASA
        // components list should fall through (URL opens in Safari).
        let url = try XCTUnwrap(URL(string: "https://popalpha.ai/internal/admin"))

        let didRoute = DeepLinkRouter.shared.handle(url: url)

        XCTAssertFalse(didRoute)
        XCTAssertNil(DeepLinkRouter.shared.pendingDestination)
    }

    func testRejectsCardURLWithoutSlug() throws {
        // /c/ alone (no slug segment) shouldn't route.
        let url = try XCTUnwrap(URL(string: "https://popalpha.ai/c/"))

        let didRoute = DeepLinkRouter.shared.handle(url: url)

        XCTAssertFalse(didRoute)
        XCTAssertNil(DeepLinkRouter.shared.pendingDestination)
    }

    // MARK: - State management

    func testConsumeClearsPendingDestination() throws {
        let url = try XCTUnwrap(URL(string: "https://popalpha.ai/c/snorlax-jungle-11"))
        DeepLinkRouter.shared.handle(url: url)
        XCTAssertNotNil(DeepLinkRouter.shared.pendingDestination)

        DeepLinkRouter.shared.consume()

        XCTAssertNil(DeepLinkRouter.shared.pendingDestination)
    }
}
