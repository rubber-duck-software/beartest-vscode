import * as vscode from 'vscode';

/**
 * Beartest event types emitted during test execution
 */
export type BeartestEventType = 'test:start' | 'test:pass' | 'test:fail';

export type BeartestTestType = 'suite' | 'test' | undefined;

/**
 * Base structure for all beartest events
 */
interface BaseBeartestEvent {
  type: BeartestEventType;
  data: {
    name: string;
    nesting: number;
    type?: BeartestTestType;
  };
}

/**
 * Event emitted when a test or suite starts
 */
export interface TestStartEvent extends BaseBeartestEvent {
  type: 'test:start';
  data: {
    name: string;
    nesting: number;
    type?: BeartestTestType;
  };
}

/**
 * Event emitted when a test or suite passes
 */
export interface TestPassEvent extends BaseBeartestEvent {
  type: 'test:pass';
  data: {
    name: string;
    nesting: number;
    type?: BeartestTestType;
    testNumber: number;
    skip: boolean;
    details: {
      duration_ms: number;
    };
  };
}

/**
 * Event emitted when a test or suite fails
 */
export interface TestFailEvent extends BaseBeartestEvent {
  type: 'test:fail';
  data: {
    name: string;
    nesting: number;
    type?: BeartestTestType;
    testNumber: number;
    skip: boolean;
    details: {
      duration_ms: number;
      error: Error;
    };
  };
}

/**
 * Union type of all beartest events
 */
export type BeartestEvent = TestStartEvent | TestPassEvent | TestFailEvent;

/**
 * Metadata stored for each TestItem
 */
export interface TestItemData {
  /** Type of test item */
  type: 'file' | 'suite' | 'test';
  /** Absolute file path for file-type items */
  filePath?: string;
  /** Full test name as reported by beartest */
  fullName: string;
  /** Nesting level from beartest events */
  nestingLevel: number;
  /** Whether this item has been discovered (created from test:start event) */
  discovered: boolean;
}

/**
 * Map to store TestItem metadata
 */
export const testItemData = new WeakMap<vscode.TestItem, TestItemData>();

/**
 * Options for running beartest
 */
export interface BeartestRunOptions {
  files: string[] | AsyncIterable<string> | Iterable<string>;
}
