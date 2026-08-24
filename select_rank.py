"""阶段三（规划中）：按响应速度对探测结果推优排序。

设计要点：
- 读取阶段二的测速结果（域名, 耗时ms）。
- 按耗时升序排列，响应快的优先。
- 输出 cf_domains_ranked.txt，每行带耗时字段，例如：
    domain#CF冷门优选_序号#耗时ms

当前为占位模块，待实现。
"""


def rank_by_speed(records: list[tuple[str, float | None]]) -> list[tuple[str, float | None]]:
    """按响应耗时升序排序，None（不可达）排末尾。"""
    raise NotImplementedError
