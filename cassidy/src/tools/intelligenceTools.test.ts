import { describe, it, expect } from 'vitest';

import { INTELLIGENCE_TOOL_DEFINITIONS } from './intelligenceTools';

// ---------------------------------------------------------------------------
// Tests — validate static tool definition array
// ---------------------------------------------------------------------------

describe('intelligenceTools', () => {
  it('exports a non-empty array', () => {
    expect(Array.isArray(INTELLIGENCE_TOOL_DEFINITIONS)).toBe(true);
    expect(INTELLIGENCE_TOOL_DEFINITIONS.length).toBeGreaterThan(0);
  });

  it('each tool has type "function" with name and description', () => {
    for (const def of INTELLIGENCE_TOOL_DEFINITIONS) {
      expect(def.type).toBe('function');
      expect(typeof def.function.name).toBe('string');
      expect(def.function.name.length).toBeGreaterThan(0);
      expect(typeof def.function.description).toBe('string');
    }
  });

  it('has no duplicate tool names', () => {
    const names = INTELLIGENCE_TOOL_DEFINITIONS.map(d => d.function.name);
    expect(new Set(names).size).toBe(names.length);
  });

  const expectedTools = [
    'getOperationalRiskScore',
    'getPredictions',
    'acknowledgePrediction',
    'getOrgChart',
    'getEscalationPath',
    'getDepartmentOverview',
    'findExpert',
    'rememberThis',
    'recallMemory',
    'forgetThis',
    'getMemoryStats',
  ];

  for (const name of expectedTools) {
    it(`includes tool "${name}"`, () => {
      const found = INTELLIGENCE_TOOL_DEFINITIONS.find(d => d.function.name === name);
      expect(found).toBeTruthy();
    });
  }

  it('rememberThis defines required parameters', () => {
    const tool = INTELLIGENCE_TOOL_DEFINITIONS.find(d => d.function.name === 'rememberThis');
    const params = tool!.function.parameters as { required?: string[] };
    expect(params.required).toContain('content');
    expect(params.required).toContain('category');
  });

  it('acknowledgePrediction requires prediction_id', () => {
    const tool = INTELLIGENCE_TOOL_DEFINITIONS.find(d => d.function.name === 'acknowledgePrediction');
    const params = tool!.function.parameters as { required?: string[] };
    expect(params.required).toContain('prediction_id');
  });
});
