# Desktop Redesign Contract

The desktop renderer is intentionally split into two redesign layers:

- `theme.css` owns the theme contract: palette, surfaces, glass, controls, inputs, status colors, shadows, radii, and compatibility aliases for older CSS modules.
- `../13-redesign.css` maps existing component classes to those semantic tokens and handles layout/responsive overrides.

For a future reskin, change `theme.css` first. Add selector-specific CSS only when the component structure or responsive behavior needs to change. Avoid adding new raw colors, gradients, shadows, or radii in component files unless they are first named as a token in `theme.css`.
