# Beartest Test Explorer for VSCode

VSCode extension that integrates [beartest](https://github.com/rubber-duck-software/beartest) with the VSCode Test Explorer.

## Features

- **Automatic Test Discovery**: Discovers test files matching `**/*.test.*` pattern
- **File/Folder Hierarchy**: Shows tests organized by your project structure
- **Run Tests**: Execute individual tests, test suites, or entire files
- **Debug Tests**: Debug your tests with breakpoints using VSCode's debugger
- **Real-time Results**: See test results as they run with duration tracking
- **Error Reporting**: View detailed error messages and stack traces

## Requirements

- VSCode 1.59.0 or higher
- beartest-js installed in your workspace

## Installation

### For Development

1. Clone this repository
2. Run `npm install` in the extension directory
3. Run `npm run compile` to build the extension
4. Press F5 to open a new VSCode window with the extension loaded

### From VSIX

1. Download the `.vsix` file
2. In VSCode, go to Extensions view
3. Click "..." menu and select "Install from VSIX..."
4. Select the downloaded file

## Usage

1. Install beartest in your project:
   ```bash
   npm install beartest
   ```

2. Create test files with the `.test.js`, `.test.ts`, or similar extension

3. The Test Explorer will automatically discover your test files

4. Click the beaker icon in the Activity Bar to open the Test Explorer

5. Run tests by clicking the play button next to any test, suite, or file

6. Debug tests by right-clicking and selecting "Debug Test"

## Configuration

Configure the extension in your VSCode settings:

```json
{
  "beartest.testFilePattern": "**/*.test.*"
}
```

### Available Settings

- `beartest.testFilePattern`: Glob pattern for discovering test files (default: `**/*.test.*`)

## How It Works

1. **Discovery**: The extension scans your workspace for files matching the test pattern and builds a file/folder hierarchy in the Test Explorer

2. **Dynamic Test Discovery**: When you run tests for the first time, the extension executes beartest and listens to `test:start` events to build the test structure inside each file

3. **Execution**: Uses beartest's event stream (`test:start`, `test:pass`, `test:fail`) to report test results in real-time

4. **Debugging**: Launches Node.js with the debugger attached, allowing you to set breakpoints in your test code

## Limitations

- Tests inside a file are only discovered after the first run (lazy discovery)
- When debugging, you can only debug entire files (not individual tests within a file)
- Beartest must be installed in your workspace's node_modules or in a `beartest-js` directory

## Development

### Building

```bash
npm run compile
```

### Watching for changes

```bash
npm run watch
```

### Testing the extension

Press F5 in VSCode to open the Extension Development Host with the extension loaded.

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.
