import * as vscode from 'vscode';
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
    vscode.window.showWarningMessage('No workspace folder found for Beartest extension');
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
 * Validate beartest configurations and provide helpful warnings
 */
function validateConfigurations(): void {
  try {
    const configurations = loadConfigurations();

    // Check if configurations array is empty
    if (configurations.length === 0) {
      vscode.window.showWarningMessage(
        'Beartest: No configurations defined. Tests will fail until you add at least one configuration pattern. ' +
        'Add "beartest.configurations" to your settings.json.'
      );
      return;
    }

    // Validate each configuration
    const issues: string[] = [];
    configurations.forEach((cfg, index) => {
      if (!cfg.pattern) {
        issues.push(`Configuration ${index + 1}: missing 'pattern'`);
      }
      if (!cfg.command) {
        issues.push(`Configuration ${index + 1}: missing 'command'`);
      }
      if (!cfg.runtimeArgs || !Array.isArray(cfg.runtimeArgs)) {
        issues.push(`Configuration ${index + 1}: 'runtimeArgs' must be an array`);
      }
    });

    if (issues.length > 0) {
      vscode.window.showErrorMessage(
        `Beartest configuration errors:\n${issues.join('\n')}`
      );
    }

    console.log(`Beartest: Loaded ${configurations.length} configuration(s)`);
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
