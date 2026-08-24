"""阶段二（规划中）：对 cf_domains.txt 中的站点进行响应速度测试。

设计要点：
- 使用 requests 的 elapsed 统计首字节/整体响应耗时（毫秒）。
- 并发测速（如 concurrent.futures.ThreadPoolExecutor）以提升效率。
- 超时阈值建议 5~8 秒，超时记为不可达。
- 将结果（域名, 耗时ms）暂存，供阶段三排序使用。

当前为占位模块，待实现。
"""


def measure_latency(domain: str, timeout: float = 6.0) -> float | None:
    """返回 domain 的响应耗时（毫秒），超时/失败返回 None。"""
    raise NotImplementedError
