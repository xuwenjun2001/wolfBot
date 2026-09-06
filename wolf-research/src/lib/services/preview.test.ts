import { describe, expect, it } from 'vitest';

import { __previewTesting } from './preview';

describe('preview process ownership', () => {
  it('parses IPv4 and IPv6 Windows listeners without including unrelated ports', () => {
    const listeners = __previewTesting.extractListeningPortsFromNetstat([
      '  TCP    0.0.0.0:4112       0.0.0.0:0       LISTENING       1234',
      '  TCP    [::]:4112          [::]:0          LISTENING       1234',
      '  TCP    127.0.0.1:4113     0.0.0.0:0       LISTENING       5678',
      '  TCP    127.0.0.1:4112     0.0.0.0:0       ESTABLISHED     9999',
    ].join('\r\n'), 4100, 4112);

    expect(listeners.get(4112)).toEqual([1234]);
    expect(listeners.has(4113)).toBe(false);
  });

  it('only treats a process command line containing the canonical workspace as owned', () => {
    const projectPath = 'D:/job/EzWin/wolfBot/wolf-research/data/projects/project-1';
    expect(__previewTesting.isProcessCommandLineWithinProject(
      '"node" D:/job/EzWin/wolfBot/wolf-research/data/projects/project-1/node_modules/next start --port 4112',
      projectPath,
    )).toBe(true);
    expect(__previewTesting.isProcessCommandLineWithinProject(
      '"node" D:/other-project/data/projects/project-1/node_modules/next start --port 4112',
      projectPath,
    )).toBe(false);
  });
});
