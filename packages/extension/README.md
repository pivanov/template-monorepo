# React Scanner Extension

Browser extension for scanning React applications and identifying performance issues.


### Environment Variables

When developing, you may need to set browser binary paths if they're not in standard locations. Create a `.env` file (copy from `.env.example`):

```env
# Example for custom Chrome path:
CHROME_BINARY="/custom/path/to/chrome"

# Example for custom Firefox path:
FIREFOX_BINARY="/custom/path/to/firefox"
```

### Development Setup
#### For Chrome
1. Run development server:
   ```bash
   pnpm dev
   ```
3. This will automatically open Chrome with the extension loaded.

<i>If you need to inspect the extension, open `chrome://extensions` in Chrome</i>
#### For Firefox

<br />

#### For Firefox
1. Run development server:
   ```bash
   pnpm dev:firefox
   ```
2. This will automatically open Firefox with the extension loaded.

<i>If you need to inspect the extension, open `about:debugging#/runtime/this-firefox` in Firefox</i>

<br />

#### For Brave

1. Run development server:
   ```bash
   pnpm dev:brave
   ```

2. This will automatically open Brave with the extension loaded.

<i>If you need to inspect the extension, open `brave://extensions` in Brave</i>

<br />

### Building for Production

To build the extension for all browsers:

```bash
pnpm pack:all
```

This will create:
- `chrome-react-scanner-extension-v1.0.0.zip`
- `firefox-react-scanner-extension-v1.0.0.zip`
- `brave-react-scanner-extension-v1.0.0.zip`

in the `build` directory.
