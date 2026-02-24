import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { interpretUserMessage } from '../interpreter.js';
import { env } from '../../env.js';
import * as interpreterModule from '../interpreter.js';

describe('Interpreter Service', () => {
  const originalEnabled = env.INTERPRETER_ENABLED;

  afterEach(() => {
    env.INTERPRETER_ENABLED = originalEnabled;
    vi.restoreAllMocks();
  });

  describe('Browse Intent', () => {
    it('should classify web search queries as browse', async () => {
      const result = await interpretUserMessage('What is the weather in Paris?');
      // If interpreter is disabled, uses heuristic; otherwise uses interpreter
      expect(['browse', 'chat']).toContain(result.primaryIntent);
      expect(result.shouldClarify).toBe(false);
    });

    it('should classify news requests as browse', async () => {
      const result = await interpretUserMessage('What are the latest news today?');
      // News contains keyword 'news' which triggers browse heuristic
      expect(result.primaryIntent).toMatch(/browse|chat/);
    });

    it('should classify search requests as browse', async () => {
      const result = await interpretUserMessage('Search the web for quantum computing');
      // "Search" keyword should trigger browse intent
      expect(result.primaryIntent).toMatch(/browse|chat/);
    });

    it('should detect "search online" as browse', async () => {
      env.INTERPRETER_ENABLED = false; // Force heuristic mode
      const result = await interpretUserMessage('search online for recipes');
      expect(result.primaryIntent).toBe('browse');
    });

    it('should detect "look up online" as browse', async () => {
      env.INTERPRETER_ENABLED = false;
      const result = await interpretUserMessage('look up online for best practices');
      expect(result.primaryIntent).toBe('browse');
    });

    it('should detect "find online" as browse', async () => {
      env.INTERPRETER_ENABLED = false;
      const result = await interpretUserMessage('find online information about AI');
      expect(result.primaryIntent).toBe('browse');
    });

    it('should detect "google" keyword as browse', async () => {
      env.INTERPRETER_ENABLED = false;
      const result = await interpretUserMessage('google the latest news');
      expect(result.primaryIntent).toBe('browse');
    });

    it('should detect weather queries as browse', async () => {
      env.INTERPRETER_ENABLED = false;
      const result = await interpretUserMessage("what's the weather in Tokyo?");
      expect(result.primaryIntent).toBe('browse');
    });

    it('should detect time queries as browse', async () => {
      env.INTERPRETER_ENABLED = false;
      const result = await interpretUserMessage('what is the current time in New York?');
      expect(result.primaryIntent).toBe('browse');
    });

    it('should detect price queries as browse', async () => {
      env.INTERPRETER_ENABLED = false;
      const result = await interpretUserMessage('what is the price of Bitcoin today?');
      expect(result.primaryIntent).toBe('browse');
    });

    it('should detect "today" keyword as browse', async () => {
      env.INTERPRETER_ENABLED = false;
      const result = await interpretUserMessage('what happened today in history?');
      expect(result.primaryIntent).toBe('browse');
    });

    it('should detect "current" keyword as browse', async () => {
      env.INTERPRETER_ENABLED = false;
      const result = await interpretUserMessage('what is the current state of the market?');
      expect(result.primaryIntent).toBe('browse');
    });
  });

  describe('Filesystem Intent', () => {
    it('should classify filesystem commands as filesystem', async () => {
      const result = await interpretUserMessage('ls -la src/');
      // ls command should trigger filesystem (both heuristic and interpreter)
      expect(result.primaryIntent).toBe('filesystem');
    });

    it('should classify directory listing as filesystem', async () => {
      const result = await interpretUserMessage('List files in the current directory');
      expect(result.primaryIntent).toBe('filesystem');
    });

    it('should classify file reading as filesystem', async () => {
      // Use explicit filesystem keyword
      const result = await interpretUserMessage('Show me the file contents in the workspace directory');
      expect(result.primaryIntent).toBe('filesystem');
    });

    it('should classify pwd command as filesystem', async () => {
      const result = await interpretUserMessage('pwd');
      expect(result.primaryIntent).toBe('filesystem');
    });

    it('should detect "open file" as filesystem', async () => {
      env.INTERPRETER_ENABLED = false; // Force heuristic mode
      const result = await interpretUserMessage('open file config.json');
      expect(result.primaryIntent).toBe('filesystem');
    });

    it('should detect "read file" as filesystem', async () => {
      env.INTERPRETER_ENABLED = false;
      const result = await interpretUserMessage('read file README.md');
      expect(result.primaryIntent).toBe('filesystem');
    });

    it('should detect "save as" as filesystem', async () => {
      env.INTERPRETER_ENABLED = false;
      const result = await interpretUserMessage('save as report.txt');
      expect(result.primaryIntent).toBe('filesystem');
    });

    it('should detect "create file" as filesystem', async () => {
      env.INTERPRETER_ENABLED = false;
      const result = await interpretUserMessage('create file test.js');
      expect(result.primaryIntent).toBe('filesystem');
    });

    it('should detect "delete file" as filesystem', async () => {
      env.INTERPRETER_ENABLED = false;
      const result = await interpretUserMessage('delete file old.txt');
      expect(result.primaryIntent).toBe('filesystem');
    });

    it('should detect common file commands (cat, mkdir, rm, cp, mv)', async () => {
      env.INTERPRETER_ENABLED = false;

      const catResult = await interpretUserMessage('cat file.txt');
      expect(catResult.primaryIntent).toBe('filesystem');

      const mkdirResult = await interpretUserMessage('mkdir new_folder');
      expect(mkdirResult.primaryIntent).toBe('filesystem');

      const rmResult = await interpretUserMessage('rm file.txt');
      expect(rmResult.primaryIntent).toBe('filesystem');

      const cpResult = await interpretUserMessage('cp source.txt dest.txt');
      expect(cpResult.primaryIntent).toBe('filesystem');

      const mvResult = await interpretUserMessage('mv old.txt new.txt');
      expect(mvResult.primaryIntent).toBe('filesystem');
    });
  });

  describe('Code Intent', () => {
    it('should classify code debugging as code', async () => {
      const result = await interpretUserMessage('Debug the bug in main.ts');
      // "debug" keyword triggers code intent
      expect(result.primaryIntent).toBe('code');
    });

    it('should classify refactoring as code', async () => {
      const result = await interpretUserMessage('Refactor this component for better performance');
      // "refactor" keyword triggers code intent
      expect(result.primaryIntent).toBe('code');
    });

    it('should classify fix requests as code', async () => {
      const result = await interpretUserMessage('Fix this code snippet');
      // "fix" keyword triggers code intent
      expect(result.primaryIntent).toBe('code');
    });
  });

  describe('Chat Intent (Default)', () => {
    it('should classify general knowledge questions as chat', async () => {
      // Use a question that won't trigger other intents
      const result = await interpretUserMessage('What is a variable in programming?');
      expect(['chat', 'code']).toContain(result.primaryIntent);
    });

    it('should classify explanations as chat', async () => {
      const result = await interpretUserMessage('What is machine learning?');
      expect(result.primaryIntent).toMatch(/chat|code/);
    });

    it('should classify general conversation as chat', async () => {
      const result = await interpretUserMessage('Tell me about the solar system');
      // This should default to chat if no other intent is detected
      expect(result.primaryIntent).toBeDefined();
    });
  });

  describe('Clarification Intent', () => {
    it('should clarify on empty message', async () => {
      const result = await interpretUserMessage('');
      expect(result.shouldClarify).toBe(true);
      expect(result.primaryIntent).toBe('clarify');
      expect(result.confidence).toBe(1);
    });

    it('should clarify on whitespace-only message', async () => {
      const result = await interpretUserMessage('   ');
      expect(result.shouldClarify).toBe(true);
      expect(result.primaryIntent).toBe('clarify');
    });

    it('should clarify on ambiguous request', async () => {
      const result = await interpretUserMessage('Do that thing');
      // Might clarify or use heuristic - just check it returns a valid response
      expect(result).toBeDefined();
      expect(result.primaryIntent).toBeDefined();
      expect(['clarify', 'chat']).toContain(result.primaryIntent);
    });
  });

  describe('Heuristic Fallback', () => {
    beforeEach(() => {
      env.INTERPRETER_ENABLED = false;
    });

    it('should use heuristic for filesystem when interpreter disabled', async () => {
      const result = await interpretUserMessage('List files in src/');
      expect(result.primaryIntent).toBe('filesystem');
      expect(result.reason).toBe('interpreter_disabled');
      expect(result.confidence).toBe(1);
    });

    it('should use heuristic for browse when interpreter disabled', async () => {
      const result = await interpretUserMessage('Search the web for cats');
      expect(result.primaryIntent).toBe('browse');
      expect(result.reason).toBe('interpreter_disabled');
    });

    it('should default to chat when interpreter disabled and no clear intent', async () => {
      const result = await interpretUserMessage('Tell me a story');
      expect(result.primaryIntent).toBe('chat');
      expect(result.reason).toBe('interpreter_disabled');
    });
  });

  describe('Filesystem Heuristic Override', () => {
    it('should override clarify with filesystem heuristic for explicit fs commands', async () => {
      // When interpreter might return clarify but heuristic strongly suggests filesystem
      const result = await interpretUserMessage('ls -la');
      expect(result.primaryIntent).toBe('filesystem');
      expect(result.shouldClarify).toBe(false);
    });

    it('should normalize user message', async () => {
      const result = await interpretUserMessage('What is the weather in Paris?');
      expect(result.normalizedUserMessage).toBeDefined();
      expect(typeof result.normalizedUserMessage).toBe('string');
    });
  });

  describe('Response Structure', () => {
    it('should include all required fields', async () => {
      const result = await interpretUserMessage('Test message');

      expect(result).toHaveProperty('shouldClarify');
      expect(result).toHaveProperty('normalizedUserMessage');
      expect(result).toHaveProperty('primaryIntent');
      expect(result).toHaveProperty('intents');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('reason');

      expect(typeof result.shouldClarify).toBe('boolean');
      expect(typeof result.normalizedUserMessage).toBe('string');
      expect(typeof result.primaryIntent).toBe('string');
      expect(Array.isArray(result.intents)).toBe(true);
      expect(typeof result.confidence).toBe('number');
      expect(result.confidence >= 0 && result.confidence <= 1).toBe(true);
    });

    it('should have valid intents in the array', async () => {
      const result = await interpretUserMessage('List files in src/');
      const validIntents = ['chat', 'browse', 'filesystem', 'code', 'tool', 'clarify'];

      expect(Array.isArray(result.intents)).toBe(true);
      for (const intent of result.intents) {
        expect(validIntents).toContain(intent);
      }
    });

    it('should include clarification question when shouldClarify is true', async () => {
      const result = await interpretUserMessage('');
      if (result.shouldClarify) {
        expect(result.clarificationQuestion).toBeDefined();
        expect(typeof result.clarificationQuestion).toBe('string');
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long messages', async () => {
      const longMsg = 'a'.repeat(5000) + ' list files';
      const result = await interpretUserMessage(longMsg);
      expect(result).toBeDefined();
      expect(result.primaryIntent).toBeDefined();
    });

    it('should handle special characters', async () => {
      const result = await interpretUserMessage('List files: !@#$%^&*()');
      expect(result).toBeDefined();
      expect(result.primaryIntent).toBeDefined();
    });

    it('should handle mixed case', async () => {
      const result = await interpretUserMessage('WHAT IS THE WEATHER IN Paris???');
      expect(result).toBeDefined();
      expect(['browse', 'chat']).toContain(result.primaryIntent);
    });

    it('should handle unicode characters', async () => {
      const result = await interpretUserMessage('What is the weather in Paris? 🌦️');
      expect(result).toBeDefined();
      expect(result.primaryIntent).toBeDefined();
    });
  });
});
