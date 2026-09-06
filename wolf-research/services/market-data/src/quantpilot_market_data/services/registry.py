from __future__ import annotations

from quantpilot_market_data.config import MarketSettings
from quantpilot_market_data.models import ProviderInfo, RegistryResponse


def build_registry(settings: MarketSettings) -> RegistryResponse:
    return RegistryResponse(
        providers=[
            ProviderInfo(
                id="wolf-research-analysis-context",
                name="Wolf Research 聚合分析上下文",
                category="analysis-context",
                status="available",
                description="共享请求并对行情、K 线、技术、财务、基本面和公告进行独立错误隔离。",
                endpoints=["/api/v1/analysis/context/{symbol}"],
            ),
            ProviderInfo(
                id="eastmoney",
                name="东方财富公开数据",
                category="market-data",
                status="degraded",
                description="实时行情、历史 K 线、证券解析、财务摘要和公告的外部适配器。",
                endpoints=[
                    "/api/v1/symbols/resolve",
                    "/api/v1/quotes/realtime/{symbol}",
                    "/api/v1/quotes/history/{symbol}",
                    "/api/v1/fundamentals/financials/{symbol}",
                    "/api/v1/events/announcements/{symbol}",
                ],
                cache_ttl_seconds=settings.kline_cache_ttl_seconds,
                limitations=[
                    "公开接口依赖网络可达；失败会返回可定位的 upstream 错误，不生成替代数据。"
                ],
            ),
            ProviderInfo(
                id="postgresql-quant",
                name="PostgreSQL 研究数据",
                category="local-storage",
                status="available" if settings.database_url else "degraded",
                description="研究池、本地 canonical bars 和短线筛选器的事实存储。",
                endpoints=[
                    "/api/v1/research/universes/summary",
                    "/api/v1/research/bars/{symbol}",
                    "/api/v1/research/screeners/a-share/short-term-candidates",
                ],
                limitations=["未配置数据库时相关端点明确返回 DATABASE_NOT_CONFIGURED。"],
            ),
        ]
    )
