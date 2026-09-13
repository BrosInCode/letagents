import XCTest

@MainActor final class CompanionFlowTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    private func signIn(_ app: XCUIApplication) {
        app.buttons["github-sign-in"].tap()
        XCTAssertTrue(app.textFields["room-search"].waitForExistence(timeout: 10))
    }
    func testSignInSearchRoomSendThreadAndSignOut() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing"]; app.launch()
        XCTAssertTrue(app.buttons["github-sign-in"].waitForExistence(timeout: 10)); signIn(app)
        let search = app.textFields["room-search"]
        search.tap(); search.typeText("No such room")
        XCTAssertTrue(app.staticTexts["No matching rooms"].waitForExistence(timeout: 3))
        app.buttons["Clear search"].tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "LetAgents, BrosInCode")).firstMatch.tap()
        XCTAssertTrue(app.buttons["thread-msg_1"].waitForExistence(timeout: 5))
        let composer = app.textFields["message-composer"]
        composer.tap(); composer.typeText("Hello from my phone")
        app.buttons["send-message"].tap()
        XCTAssertTrue(app.staticTexts["Hello from my phone"].waitForExistence(timeout: 5))
        app.swipeDown()
        app.buttons["thread-msg_1"].tap()
        XCTAssertTrue(app.staticTexts["Yes. Replies stay in this thread."].waitForExistence(timeout: 5))
        let reply = app.textFields["message-composer"]
        reply.tap(); reply.typeText("Keep going in this thread")
        app.buttons["send-message"].tap()
        XCTAssertTrue(app.staticTexts["Keep going in this thread"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["account-button"].tap(); app.buttons["sign-out"].tap()
        XCTAssertTrue(app.buttons["github-sign-in"].waitForExistence(timeout: 5))
    }
    func testFailedSendKeepsDraftAndRetryWorks() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing", "--fail-first-send"]; app.launch(); signIn(app)
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "LetAgents, BrosInCode")).firstMatch.tap()
        let composer = app.textFields["message-composer"]
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
