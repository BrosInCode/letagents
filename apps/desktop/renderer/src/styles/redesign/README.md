# Desktop Redesign Contract

The desktop renderer is intentionally split into three redesign layers:

- `theme.css` owns the theme contract: palette, surfaces, glass, controls, inputs, status colors, shadows, radii, and compatibility aliases for older CSS modules.
- `../13-redesign.css` maps existing component classes to those semantic tokens and keeps broad compatibility with the older CSS modules.
- `product-system.css` owns the final product skin: true-black base, surface ladder, control colors, edge strength, radii, and the chat/product aliases consumed by the final layout layer.
- `../14-chat-interface.css` owns the final information architecture: command rail, room command bar, conversation canvas, setup, settings, board, activity, rent, modals, attachments, contextual overlays, composer, and compact responsive behavior.

For a future reskin, change `theme.css` and `product-system.css` first. For a future layout redesign, change `14-chat-interface.css` first. Add selector-specific CSS only when the component structure or responsive behavior needs to change. Avoid adding new raw colors, gradients, shadows, or radii in component files unless they are first named as a token in `theme.css` or `product-system.css`.
