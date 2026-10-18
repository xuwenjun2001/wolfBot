import { writeFile } from 'node:fs/promises';
import { chartPanelClientSource } from '../../src/lib/utils/scaffold-chart-panel';
void writeFile('src/components/quant/PriceVolumeChart.tsx',
  '// Generated from scaffold-chart-panel.ts by sync-chart-panel.ts; edit the source template.\n' + chartPanelClientSource)
  .catch(error => { console.error(error); process.exitCode = 1; });
