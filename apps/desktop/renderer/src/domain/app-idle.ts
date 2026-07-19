/**
 * Attribute stamped on the document root while the app is idle (window hidden
 * or blurred). CSS scopes the launcher orb's decorative ink animations to pause
 * under `:root[data-app-idle]`.
 */
export const APP_IDLE_ATTRIBUTE = "data-app-idle";

/**
 * The app-agent launcher orb runs three decorative `infinite` ink animations
 * through an feGaussianBlur + feDisplacementMap glass filter, so every frame
 * forces a full GPU filter re-evaluation even while the app sits idle. They only
 * need to animate while the user is actually looking, so we pause them whenever
 * the window is hidden OR blurred. Pausing on blur (not just hidden) is the
 * deliberate battery choice — trivially revertible to hidden-only by dropping
 * the `focused` term.
 */
export function isAppIdle(input: { hidden: boolean; focused: boolean }): boolean {
  return input.hidden || !input.focused;
}
