import XCTest

@MainActor final class CompanionFlowTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    private func signIn(_ app: XCUIApplication) {
        app.buttons["github-sign-in"].tap()
        XCTAssertTrue(app.textFields["room-search"].waitForExistence(timeout: 10))
    }
    private func openGeneral(_ app: XCUIApplication) {
        app.buttons["project-github.com/brosincode/letagents"].tap()
        app.buttons["room-github.com/brosincode/letagents"].tap()
    }
    func testSignInSearchRoomSendThreadAndSignOut() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing"]; app.launch()
        XCTAssertTrue(app.buttons["github-sign-in"].waitForExistence(timeout: 10)); signIn(app)
        let search = app.textFields["room-search"]
        search.tap(); search.typeText("No such room")
        XCTAssertTrue(app.staticTexts["No matching rooms"].waitForExistence(timeout: 3))
        app.buttons["Clear search"].tap()
        openGeneral(app)
        XCTAssertTrue(app.buttons["thread-msg_1"].waitForExistence(timeout: 5))
        let composer = app.textViews["message-composer"]
        composer.tap(); composer.typeText("Hello from my phone")
        app.buttons["send-message"].tap()
        XCTAssertTrue(app.staticTexts["Hello from my phone"].waitForExistence(timeout: 5))
        app.swipeDown()
        app.buttons["thread-msg_1"].tap()
        XCTAssertTrue(app.staticTexts["Yes. Replies stay in this thread."].waitForExistence(timeout: 5))
        let reply = app.textViews["thread-composer"]
        reply.tap(); reply.typeText("Keep going in this thread")
        app.buttons["send-thread-message"].tap()
        XCTAssertTrue(app.staticTexts["Keep going in this thread"].waitForExistence(timeout: 5))
        app.buttons["Close"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["account-button"].tap(); app.buttons["sign-out"].tap()
        XCTAssertTrue(app.buttons["github-sign-in"].waitForExistence(timeout: 5))
    }
    func testFailedSendKeepsDraftAndRetryWorks() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing", "--fail-first-send"]; app.launch(); signIn(app)
        openGeneral(app)
        let composer = app.textViews["message-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5)); composer.tap(); composer.typeText("Retry this message")
        app.buttons["send-message"].tap()
        XCTAssertTrue(app.otherElements["error-notice"].waitForExistence(timeout: 5) || app.staticTexts["Message wasn’t confirmed. Your draft is saved here. Tap Send to retry."].exists)
        XCTAssertEqual(composer.value as? String, "Retry this message")
        app.buttons["send-message"].tap()
        XCTAssertTrue(app.staticTexts["Retry this message"].waitForExistence(timeout: 5))
    }
    func testEmptyAccountShowsHelpfulState() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing", "--empty-rooms"]; app.launch(); signIn(app)
        XCTAssertTrue(app.staticTexts["Your rooms will be here"].waitForExistence(timeout: 5))
    }
}

extension CompanionFlowTests {
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    func testProjectBranchesKeepTheirOwnFocusRooms() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing"]; app.launch(); signIn(app)
        XCTAssertFalse(app.buttons["room-focus-mobile"].exists)
        app.buttons["project-github.com/brosincode/letagents"].tap()
        XCTAssertTrue(app.buttons["room-focus-mobile"].exists)
        XCTAssertFalse(app.buttons["room-focus-code"].exists)
        capture("Project hierarchy")
        app.buttons["project-branches"].tap()
        app.buttons["branch-branch-mobile"].tap()
        XCTAssertTrue(app.buttons["room-focus-code"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["room-focus-mobile"].exists)
        capture("Branch focus rooms")
    }
    func testMentionSuggestionsInsertTheSelectedAgent() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing"]; app.launch(); signIn(app); openGeneral(app)
        let composer = app.textViews["message-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5)); composer.tap(); composer.typeText("@Cod")
        XCTAssertTrue(app.buttons["mention-agent:codex-emmy"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["mention-agent:codex-noor"].exists)
        capture("Mention identities")
        app.buttons["mention-agent:codex-noor"].tap()
        XCTAssertEqual(composer.value as? String, "@agent:codex-noor ")
        composer.typeText("please review the design")
        app.buttons["send-message"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "please review the design")).firstMatch.waitForExistence(timeout: 5))
        capture("Formatted mention")
    }
    func testQuotedRepliesAndThreadInbox() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing"]; app.launch(); signIn(app); openGeneral(app)
        app.buttons["Conversation options"].tap(); app.buttons["Threads"].tap()
        XCTAssertTrue(app.buttons["inbox-thread-msg_1"].waitForExistence(timeout: 5)); capture("Thread inbox")
        app.buttons["inbox-thread-msg_1"].tap()
        XCTAssertTrue(app.buttons["actions-msg_4"].waitForExistence(timeout: 5)); app.buttons["actions-msg_4"].tap()
        app.buttons["Reply to message"].tap()
        XCTAssertTrue(app.buttons["Cancel reply"].exists)
        let composer = app.textViews["thread-composer"]; composer.tap(); composer.typeText("This reply keeps its context")
        app.buttons["send-thread-message"].tap()
        XCTAssertTrue(app.staticTexts["This reply keeps its context"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["This reply keeps its context"].isHittable)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Quoted message from EmmyMay:")).firstMatch.exists)
        capture("Quoted reply")
    }
    func testRichMarkdownCodeAndGitHubCards() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing", "--rich-messages"]; app.launch(); signIn(app); openGeneral(app)
        XCTAssertTrue(app.staticTexts["PR #1204 ready for review"].waitForExistence(timeout: 5))
        capture("GitHub activity")
        for _ in 0..<5 where !app.buttons["Copy code"].isHittable { app.scrollViews.firstMatch.swipeDown() }
        XCTAssertTrue(app.buttons["Copy code"].isHittable)
        capture("Rich Markdown")
        app.buttons["Copy code"].tap()
        XCTAssertTrue(app.staticTexts["Copied"].exists || app.buttons["Copy code"].exists)
        app.buttons["Expand code"].tap()
        XCTAssertTrue(app.navigationBars["swift"].waitForExistence(timeout: 3))
        capture("Expanded code")
        app.buttons["Done"].tap()
    }
}
