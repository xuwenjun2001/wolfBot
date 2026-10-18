"""Live paired prep benchmark. Database writes use a rollback-only isolated test schema."""
import copy
import importlib.util
import json
import os
import statistics
import time
from datetime import date
from pathlib import Path

import pytest
from quantpilot_market_data.cli import load_market_environment
from quantpilot_market_data.providers.tactics_source import TacticsSource
from quantpilot_market_data.repositories import tactics as repo
from quantpilot_market_data.services import tactic_incremental as inc
from quantpilot_market_data.services.tactics import fetch


def main():
    load_market_environment()
    root=Path(__file__).resolve().parents[2]
    recorded=json.loads((root/'data/validation/tactic-incremental/results.json').read_text(encoding='utf-8'))
    samples=recorded['samples']
    target=recorded['target']
    with repo.connection() as c:
        context=c.execute("SELECT context FROM quant.tactic_runs WHERE trade_date=%s ORDER BY created_at DESC LIMIT 1",(target,)).fetchone()['context']
    days=[d for d in context['sessions'] if d<=target]
    spec=importlib.util.spec_from_file_location('benchmark_fixture',root/'services/market-data/tests/test_tactics_postgres.py')
    module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    patch=pytest.MonkeyPatch(); fixture=module.db.__wrapped__(patch); next(fixture)
    source=TacticsSource(timeout=20)
    output={'target':target,'isolation':'rollback-only test schema; no production cache writes; excludes outer commit and connection setup','samples':[]}
    folder=root/'data/validation/tactic-incremental'; folder.mkdir(parents=True,exist_ok=True)
    try:
        run=repo.enqueue(date.fromisoformat(target),'benchmark'); repo.claim('benchmark')
        source.request('bars',symbol=samples[0]['symbol'],start=target,end=target)
        for index,sample in enumerate(samples):
            symbol=sample['symbol']; baseline=sample['results']['full120']['bars'][:-1]
            window={'source':'baostock','acquisition_version':inc.VERSION,'trade_date':days[-2],
                    'last_full_trade_date':days[-2],'bars':baseline}
            entry={'symbol':symbol,'results':{}}
            orders=['full','incremental'] if index%2==0 else ['incremental','full']
            if index<3: orders.append('forced_fallback')
            for mode in orders:
                os.environ['QUANTPILOT_TACTICS_INCREMENTAL_ENABLED']='0' if mode=='full' else '1'
                candidate=copy.deepcopy(window)
                if mode=='forced_fallback':
                    for key in ('open','close','high','low'): candidate['bars'][-2][key]+=0.01
                metrics=inc.diagnostics(); began=time.perf_counter()
                try:
                    bars,state,reason=inc.prepare(candidate,{'listed_at':'2000-01-01'},target,days,'1',
                        lambda start:fetch(source,run['id'],'benchmark','bars',metrics=metrics,symbol=symbol,start=start,end=target),metrics)
                    write=time.perf_counter()
                    if state!='gap': repo.persist_bars(run['id'],'benchmark',symbol,bars)
                    metrics['persist_seconds']+=time.perf_counter()-write
                    pause=time.perf_counter(); time.sleep(0.3); metrics['wait_seconds']+=time.perf_counter()-pause
                    metrics['prepare_seconds']=time.perf_counter()-began
                    repo.save_item(run['id'],'benchmark',{'symbol':symbol,'name':'benchmark'},state,reason,bars,target,metrics)
                    actual=time.perf_counter()-began
                    saved=repo.prepared_items(run['id'])[symbol]['acquisition']
                    entry['results'][mode]={**saved,'actual_prepare_seconds':actual,'state':state,'reason':reason}
                except Exception as e:
                    entry['results'][mode]={'error':str(e),'actual_prepare_seconds':time.perf_counter()-began}
            output['samples'].append(entry)
            (folder/'preparation-results.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
            print(json.dumps({'progress':index+1,'symbol':symbol,'seconds':{k:round(v['actual_prepare_seconds'],3) for k,v in entry['results'].items()}},ensure_ascii=False),flush=True)
        output['summary']={}
        for mode in ['full','incremental','forced_fallback']:
            valid=[s['results'][mode] for s in output['samples'] if mode in s['results'] and 'error' not in s['results'][mode]]
            output['summary'][mode]={'count':len(valid),'modes':[v['mode'] for v in valid],**{key:statistics.mean(v[key] for v in valid) for key in ['fetch_seconds','validation_seconds','persist_seconds','wait_seconds','actual_prepare_seconds']} } if valid else {'count':0}
        (folder/'preparation-results.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(output['summary'],ensure_ascii=False),flush=True)
    finally:
        source.close()
        fixture.close()
        patch.undo()

if __name__=='__main__': main()
