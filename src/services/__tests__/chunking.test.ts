import { describe, it, expect } from 'vitest';
import { chunkMarkdown, processContent } from '../chunking.js';

describe('Chunking Service', () => {
  describe('chunkMarkdown', () => {
    it('should split markdown by headings', () => {
      const content = `# Heading 1

Content for heading 1.

## Heading 2

Content for heading 2.`;

      const chunks = chunkMarkdown(content);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].heading).toBe('Heading 1');
    });

    it('should respect max tokens', () => {
      const content = 'a'.repeat(5000); // Very long content
      const chunks = chunkMarkdown(content, 800);

      chunks.forEach(chunk => {
        expect(chunk.tokens).toBeLessThanOrEqual(800);
      });
    });

    it('should handle empty content', () => {
      const chunks = chunkMarkdown('');
      expect(chunks).toEqual([]);
    });
  });

  describe('processContent', () => {
    it('should chunk and split large sections', () => {
      const content = `# Section

${'Very long text. '.repeat(500)}`;

      const chunks = processContent(content, 800);

      chunks.forEach(chunk => {
        expect(chunk.tokens).toBeLessThanOrEqual(800);
      });
    });

    it('should preserve heading context', () => {
      const content = `# Important Section

Important information.`;

      const chunks = processContent(content);

      expect(chunks[0].heading).toBe('Important Section');
    });
  });
});
