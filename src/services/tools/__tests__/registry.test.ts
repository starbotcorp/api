import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolDefinition } from '../types.js';

describe('Tool Registry', () => {
  it('should register and retrieve tools', () => {
    const registry = new ToolRegistry();

    const testTool: ToolDefinition = {
      name: 'test_tool',
      description: 'A test tool',
      parameters: [
        {
          name: 'input',
          type: 'string',
          description: 'Test input',
          required: true,
        },
      ],
      execute: async () => ({
        success: true,
        content: 'test result',
      }),
    };

    registry.register(testTool);
    expect(registry.has('test_tool')).toBe(true);
    expect(registry.get('test_tool')).toEqual(testTool);
  });

  it('should list all registered tools', () => {
    const registry = new ToolRegistry();

    const tool1: ToolDefinition = {
      name: 'tool1',
      description: 'Tool 1',
      parameters: [],
      execute: async () => ({ success: true, content: '' }),
    };

    const tool2: ToolDefinition = {
      name: 'tool2',
      description: 'Tool 2',
      parameters: [],
      execute: async () => ({ success: true, content: '' }),
    };

    registry.register(tool1);
    registry.register(tool2);

    const allTools = registry.getAll();
    expect(allTools.length).toBe(2);
    expect(allTools.map(t => t.name)).toContain('tool1');
    expect(allTools.map(t => t.name)).toContain('tool2');
  });

  it('should convert tools to OpenAI function format', () => {
    const registry = new ToolRegistry();

    const testTool: ToolDefinition = {
      name: 'test_tool',
      description: 'A test tool',
      parameters: [
        {
          name: 'query',
          type: 'string',
          description: 'Search query',
          required: true,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Result limit',
          required: false,
          default: 10,
        },
      ],
      execute: async () => ({ success: true, content: '' }),
    };

    registry.register(testTool);

    const openAIFunctions = registry.toOpenAIFunctions();
    expect(openAIFunctions.length).toBe(1);

    const fn = openAIFunctions[0];
    expect(fn.name).toBe('test_tool');
    expect(fn.description).toBe('A test tool');
    expect(fn.parameters.type).toBe('object');
    expect(fn.parameters.required).toContain('query');
    expect(fn.parameters.required).not.toContain('limit');
    expect(fn.parameters.properties.query.type).toBe('string');
    expect(fn.parameters.properties.limit.type).toBe('number');
    expect(fn.parameters.properties.limit.default).toBe(10);
  });

  it('should handle tool overwriting', () => {
    const registry = new ToolRegistry();

    const tool1: ToolDefinition = {
      name: 'tool',
      description: 'Version 1',
      parameters: [],
      execute: async () => ({ success: true, content: 'v1' }),
    };

    const tool2: ToolDefinition = {
      name: 'tool',
      description: 'Version 2',
      parameters: [],
      execute: async () => ({ success: true, content: 'v2' }),
    };

    registry.register(tool1);
    registry.register(tool2);

    expect(registry.getAll().length).toBe(1);
    const tool = registry.get('tool');
    expect(tool?.description).toBe('Version 2');
  });
});
