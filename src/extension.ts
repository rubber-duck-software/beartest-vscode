import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { createTestDiscovery } from './testDiscovery';
import { createTestProfiles } from './testRunner';
import { loadConfigurations } from './configResolver';

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Create the test controller
  const controller = vscode.tests.createTestController(
    'beartestTestController',
    'Beartest'
  );

  context.subscriptions.push(controller);

  // Initialize test discovery for each workspace folder
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    console.log('Beartest: No workspace folder found');
    return;
  }

  // Check if beartest-js is installed in any workspace folder
  const isBeartestInstalled = await hasBeartestInstalled(workspaceFolders);
  if (!isBeartestInstalled) {
    console.log('Beartest: beartest-js not found in any workspace package.json, skipping activation');
    return;
  }

  // Set up discovery for each workspace folder
  for (const workspaceFolder of workspaceFolders) {
    const discovery = await createTestDiscovery(controller, workspaceFolder);
    context.subscriptions.push(discovery);
  }

  // Validate configurations on activation
  validateConfigurations();

  // Set up test runner profiles
  const { runProfile, debugProfile } = createTestProfiles(controller);
  context.subscriptions.push(runProfile, debugProfile);

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('beartest')) {
        // Re-validate configurations
        validateConfigurations();

        // Refresh test discovery when configuration changes
        vscode.window.showInformationMessage(
          'Beartest configuration changed. Please reload the window to apply changes.'
        );
      }
    })
  );

  console.log('Beartest Test Explorer extension activated');
}

/**
 * Check if beartest-js is installed in any workspace folder
 */
async function hasBeartestInstalled(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<boolean> {
  for (const folder of workspaceFolders) {
    const packageJsonPath = path.join(folder.uri.fsPath, 'package.json');

    try {
      if (fs.existsSync(packageJsonPath)) {
        const packageJsonContent = await fs.promises.readFile(packageJsonPath, 'utf8');
        const packageJson = JSON.parse(packageJsonContent);

        // Check both dependencies and devDependencies
        const hasBeartest =
          (packageJson.dependencies && 'beartest-js' in packageJson.dependencies) ||
          (packageJson.devDependencies && 'beartest-js' in packageJson.devDependencies);

        if (hasBeartest) {
          return true;
        }
      }
    } catch (error) {
      console.error(`Failed to read package.json in ${folder.uri.fsPath}:`, error);
    }
  }

  return false;
}

/**
 * Validate beartest configurations and provide helpful warnings
 */
function validateConfigurations(): void {
  try {
    const configurations = loadConfigurations();

    // loadConfigurations now always returns at least the default configuration,
    // so we check if it's using the default
    const rawConfigs = vscode.workspace
      .getConfiguration("beartest")
      .get<any[]>("configurations", []);

    if (rawConfigs.length === 0) {
      console.log('Beartest: Using default configuration (pattern: "**/*.test.*", command: "node")');
    } else {
      console.log(`Beartest: Loaded ${configurations.length} configuration(s)`);

      // Log the patterns for debugging
      configurations.forEach((cfg, index) => {
        console.log(`  ${index + 1}. Pattern: "${cfg.pattern}", Command: "${cfg.command}"`);
      });
    }
  } catch (error) {
    vscode.window.showErrorMessage(
      `Beartest configuration validation failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  console.log('Beartest Test Explorer extension deactivated');
}
