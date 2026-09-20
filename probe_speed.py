"""只跑优选测速：读取 cf_domains.txt，产出 ips.txt 与 best_domains.txt。"""

from cf_probe_select import OUTPUT_FILE, load_existing_domains, select_best_ips


def main():
    saved, _ = load_existing_domains(OUTPUT_FILE)
    if not saved:
        print(f"[!] {OUTPUT_FILE} 为空，跳过测速")
        return
    print(f"[*] 待测速域名 {len(saved)} 个")
    select_best_ips(saved)


if __name__ == "__main__":
    main()
