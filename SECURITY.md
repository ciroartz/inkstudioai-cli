# Security

Please report security problems privately to help@inkstudioai.com, not in a public issue. Include the steps to reproduce, the CLI version (`inkstudioai --version`), and your Node.js version.

The CLI stores your API key in `~/.config/inkstudioai/config.json` (on Windows, `%APPDATA%\inkstudioai\config.json`) with file mode 0600. To stop a key from working, revoke it at https://inkstudioai.com/account?view=api-keys.
