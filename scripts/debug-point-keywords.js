const { q } = require('../lib/db');

const want = {
  'ds5-2': ['分块', '索引顺序'],
  'os2-9': ['生产者', '消费者', '哲学家', '读者', '写者', '银行取号', '理发店', '吸烟者', '同步'],
  'os2-10': ['管程'],
  'os3-2': ['动态分区', '可变分区', '首次适应', '最佳适应', '最坏适应', '紧凑', '空闲分区'],
  'os3-3': ['分页', '页表', '地址变换', '快表', '页框'],
  'os3-4': ['段式', '段页式', '段表', '分段'],
  'os3-6': ['页面置换', '缺页', 'OPT', 'FIFO', 'LRU', 'CLOCK', 'Belady'],
  'os3-7': ['工作集', '抖动', '内存映射'],
  'os4-3': ['文件共享', '硬链接', '软链接', '存取控制', '保护'],
  'os4-6': ['磁盘调度', 'SCAN', 'SSTF', 'C-SCAN', 'LOOK', '电梯'],
  'cn1-4': ['分层', '协议', '接口', '服务'],
  'cn3-4': ['后退', '选择重传', 'GBN', 'SR', '滑动窗口', '窗口', '序号'],
  'cn3-7': ['交换机', '网桥', 'VLAN'],
  'cn4-4': ['ARP', 'DHCP', 'ICMP'],
  'co2-4': ['乘法', 'Booth', '除法'],
  'co2-6': ['浮点', '舍入'],
  'co3-8': ['TLB', 'Cache', '页表', '访存'],
  'co5-7': ['超标量', '动态流水', '多发射'],
  'os2-12': ['银行家'],
  'os4-5': ['索引分配', 'inode', '混合索引', '空闲'],
  'cn1-2': ['时延', '带宽积', 'RTT', '速率'],
  'cn2-3': ['曼彻斯特', '编码', '调制'],
  'cn2-5': ['FDM', 'TDM', 'WDM', 'CDMA', '复用']
};

for (const [pid, kws] of Object.entries(want)) {
  const like = kws.map((t) =>
    `(title LIKE '%${t}%' OR section_name LIKE '%${t}%' OR tags_json LIKE '%${t}%' OR content LIKE '%${t}%')`
  ).join(' OR ');
  const n = q.get(`SELECT COUNT(*) n FROM qb_questions WHERE ${like}`).n;
  console.log(pid.padEnd(8), String(n).padStart(4), kws.join('、'));
}
