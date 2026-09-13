import XCTest

@MainActor final class CompanionFlowTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    private func signIn(_ app: XCUIApplication) {
        app.buttons["github-sign-in"].tap()
        XCTAssertTrue(app.textFields["room-search"].waitForExistence(timeout: 10))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isHittable == true"), object: app.buttons["account-button"])
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 5), .completed)
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
        XCTAssertEqual(reply.value as? String, "Keep going in this thread")
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
        app.buttons["Quote reply"].tap()
        XCTAssertTrue(app.buttons["Cancel reply"].exists)
        let composer = app.textViews["thread-composer"]; composer.tap(); composer.typeText("This reply keeps its context")
        app.buttons["send-thread-message"].tap()
        XCTAssertTrue(app.staticTexts["This reply keeps its context"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["This reply keeps its context"].isHittable)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Quoted message from EmmyMay:")).firstMatch.exists)
        capture("Quoted reply")
        app.buttons["quote-msg_11"].tap()
        XCTAssertTrue(app.buttons["back-to-reply"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Can I reply to a specific message?"].firstMatch.isHittable)
        capture("Jump to quoted original")
        app.buttons["back-to-reply"].tap()
        XCTAssertTrue(app.staticTexts["This reply keeps its context"].isHittable)
    }
    func testSwipeToQuoteChangeCancelAndRetryInRoom() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing", "--fail-first-send"]; app.launch(); signIn(app); openGeneral(app)
        let message = app.staticTexts["On it. Your rooms will be waiting right here when you sign in."]
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        let start = message.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 110, dy: 0)))
        XCTAssertTrue(app.buttons["reply-preview"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["reply-preview"].label.contains("Claude"))
        app.buttons["Cancel reply"].tap(); XCTAssertFalse(app.buttons["reply-preview"].exists)
        app.buttons["actions-msg_3"].tap(); app.buttons["Quote reply"].tap()
        let composer = app.textViews["message-composer"]
        composer.tap(); composer.typeText("A room reply with context")
        app.buttons["send-message"].tap()
        XCTAssertTrue(app.staticTexts["Message wasn’t confirmed. Your draft is saved here. Tap Send to retry."].waitForExistence(timeout: 5))
        XCTAssertEqual(composer.value as? String, "A room reply with context")
        XCTAssertTrue(app.buttons["reply-preview"].label.contains("Claude"))
        capture("Quoted draft after failed send")
        app.buttons["send-message"].tap()
        XCTAssertTrue(app.buttons["quote-msg_11"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["reply-preview"].exists)
        XCTAssertTrue(app.textViews["message-composer"].exists)
        capture("Quote reply in the room")
    }
    func testOlderQuotedMessageLoadsAndRetriesWithoutLosingPosition() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing", "--older-quote", "--fail-first-quote"]; app.launch(); signIn(app); openGeneral(app)
        XCTAssertTrue(app.buttons["quote-msg_100"].waitForExistence(timeout: 5)); app.buttons["quote-msg_100"].tap()
        XCTAssertTrue(app.buttons["Try again"].waitForExistence(timeout: 5)); app.buttons["Try again"].tap()
        XCTAssertTrue(app.buttons["Copy message"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["The mobile flow is ready to review. GitHub → projects → conversation."].firstMatch.exists)
        capture("Older quoted original")
        app.buttons["Done"].tap()
        XCTAssertTrue(app.staticTexts["An older message has the context."].isHittable)
    }
    func testRichMarkdownCodeAndGitHubCards() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing", "--rich-messages"]; app.launch(); signIn(app); openGeneral(app)
        XCTAssertTrue(app.staticTexts["PR #1204 ready for review"].waitForExistence(timeout: 5))
        capture("GitHub activity")
        for _ in 0..<5 where !app.buttons["Copy code"].isHittable { app.scrollViews.firstMatch.swipeDown() }
        XCTAssertTrue(app.buttons["Copy code"].isHittable)
        capture("Rich Markdown")
        let code = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "let room = client.room(")).firstMatch
        let originalX = code.frame.minX
        let codePoint = app.buttons["Copy code"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).withOffset(CGVector(dx: -20, dy: 45))
        codePoint.press(forDuration: 0.05, thenDragTo: codePoint.withOffset(CGVector(dx: -140, dy: 0)))
        XCTAssertLessThan(code.frame.minX, originalX - 40, "Wide code must still scroll horizontally")
        codePoint.withOffset(CGVector(dx: -140, dy: 0)).press(forDuration: 0.05, thenDragTo: codePoint)
        XCTAssertFalse(app.buttons["Cancel reply"].exists, "Swiping inside code must not quote its message")
        app.buttons["Copy code"].tap()
        XCTAssertTrue(app.staticTexts["Copied"].exists || app.buttons["Copy code"].exists)
        app.buttons["Expand code"].tap()
        XCTAssertTrue(app.navigationBars["swift"].waitForExistence(timeout: 3))
        capture("Expanded code")
        app.buttons["Done"].tap()
    }
}

extension CompanionFlowTests {
    func testAccountButtonShowsSignOutAndReturnsToSignIn() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing"]; app.launch(); signIn(app)
        let account = app.buttons["account-button"]
        XCTAssertTrue(account.isHittable); XCTAssertEqual(account.label, "Account"); account.tap()
        XCTAssertTrue(app.staticTexts["@EmmyMay · GitHub"].waitForExistence(timeout: 5))
        capture("Account and sign out")
        app.buttons["sign-out"].tap()
        XCTAssertTrue(app.buttons["github-sign-in"].waitForExistence(timeout: 5))
        signIn(app); XCTAssertTrue(app.buttons["account-button"].isHittable)
    }
    func testConnectedNowIsSeparateFromRoomHistory() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing"]; app.launch(); signIn(app); openGeneral(app)
        app.buttons["Conversation options"].tap(); app.buttons["People & agents"].tap()
        XCTAssertTrue(app.staticTexts["Working on the mobile companion"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Past agent"].exists)
        capture("Connected now")
        app.buttons["History"].tap()
        XCTAssertTrue(app.staticTexts["Past agent"].waitForExistence(timeout: 5) || app.otherElements["history-past-agent"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Working on the mobile companion"].exists)
        app.buttons["Load more history"].tap()
        XCTAssertTrue(app.staticTexts["Noor"].waitForExistence(timeout: 5) || app.otherElements["history-past-human"].waitForExistence(timeout: 5))
        capture("Participant history")
    }
    func testComposerAndMessageFitTheScreenAndFilePickerOpens() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing", "--rich-messages"]; app.launch(); signIn(app); openGeneral(app)
        let composer = app.textViews["message-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(composer.frame.minX, 0)
        XCTAssertLessThanOrEqual(composer.frame.maxX, app.frame.maxX)
        XCTAssertTrue(app.buttons["add-attachment"].isHittable)
        XCTAssertTrue(app.buttons["send-message"].isHittable)
        capture("Room controls and alignment")
        app.buttons["add-attachment"].tap(); app.buttons["Choose files"].tap()
        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 5))
        capture("Native file picker")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["add-attachment"].waitForExistence(timeout: 5))
    }
}

extension CompanionFlowTests {
    func testPhotoAttachmentDraftSendRetryAndPreview() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing", "--fail-first-send"]; app.launch(); signIn(app); openGeneral(app)
        app.buttons["add-attachment"].tap(); app.buttons["Photo library"].tap()
        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 5))
        capture("Photo picker")
        let photo = app.images.matching(identifier: "PXGGridLayout-Info").firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 5)); photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap(); app.buttons["Done"].tap()
        let remove = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Remove ")).firstMatch
        XCTAssertTrue(remove.waitForExistence(timeout: 10))
        capture("Photo attachment draft")
        remove.tap(); XCTAssertFalse(remove.exists)
        XCTAssertFalse(app.buttons["send-message"].isEnabled)
        app.buttons["add-attachment"].tap(); app.buttons["Photo library"].tap()
        XCTAssertTrue(photo.waitForExistence(timeout: 5)); photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap(); app.buttons["Done"].tap()
        XCTAssertTrue(remove.waitForExistence(timeout: 10))
        app.buttons["send-message"].tap()
        XCTAssertTrue(app.staticTexts["Message wasn’t confirmed. Your draft is saved here. Tap Send to retry."].waitForExistence(timeout: 10))
        XCTAssertTrue(remove.exists)
        app.buttons["send-message"].tap()
        let attachment = app.buttons["attachment-att_1"]
        XCTAssertTrue(attachment.waitForExistence(timeout: 10)); XCTAssertFalse(remove.exists)
        capture("Sent photo attachment")
        attachment.tap()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.otherElements["QLPreviewControllerView"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Share attachment"].exists)
        XCTAssertTrue(app.otherElements["QLPreviewControllerView"].images.firstMatch.waitForExistence(timeout: 5))
        capture("Attachment preview")
        app.buttons["Done"].tap()
        XCTAssertTrue(attachment.waitForExistence(timeout: 5))
    }
}
