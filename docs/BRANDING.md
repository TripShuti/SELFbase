# SELFbase identity

The 01C mark combines two open page shapes and a small amber connection.
`BrandMark` renders it as an inline SVG with the surrounding text color;
`app/icon.svg` adapts to the browser's light/dark color scheme.
The wordmark uses Geist: semibold `SELF`, regular `base`.

The `accent` palette in `web/tailwind.config.ts` belongs to application
interactions: current navigation, selection, drag targets, focused controls,
view switches and primary actions. Light mode uses darker amber for small text
and focus outlines; gold controls use dark labels. Data/status colors,
user-selected content tones, avatars and URL cells keep their own palettes.

Bitmap fallbacks are generated from `web/app/icon.svg`:

```sh
node web/scripts/generate-brand-icons.cjs
```

This updates the 16/32/48px ICO and the 180px Apple icon. Keep the inline mark's
geometry aligned with the SVG when changing the symbol.

The screenshots show the running application with an isolated disposable
workspace and synthetic records, not a mockup or production user data.

![Dark theme](assets/branding-dark.png)

![Light theme](assets/branding-light.png)

Validation: 254 web unit tests, TypeScript, production Next.js build, and
Playwright checks against the production build (both themes, active navigation,
cell selection, keyboard focus and favicon delivery; no browser page errors).
