// ============================================================
//  408 知识图谱（依据全国硕士研究生招生考试计算机学科专业基础综合考试大纲整理）
//  每个知识点：weight=考频/分值权重(1-5)  diff=难度(1-5)  hours=建议学时  pre=前置知识点
// ============================================================

const SUBJECTS = [
  {
    id: 'ds', name: '数据结构', score: 45, color: '#2563eb',
    chapters: [
      { id: 'ds1', name: '线性表', points: [
        { id: 'ds1-1', name: '线性表的定义与基本操作', weight: 3, diff: 1, hours: 1.5, tags: ['基础'] },
        { id: 'ds1-2', name: '顺序表的存储与插入删除', weight: 4, diff: 2, hours: 2, tags: [] },
        { id: 'ds1-3', name: '单链表的建立、插入与删除', weight: 5, diff: 3, hours: 3, tags: ['必考'] },
        { id: 'ds1-4', name: '双链表与循环链表', weight: 3, diff: 2, hours: 2, tags: [] },
        { id: 'ds1-5', name: '顺序表与链表的比较与选型', weight: 3, diff: 2, hours: 1, tags: [] },
        { id: 'ds1-6', name: '线性表经典算法题（合并/逆置/找中点/删除重复）', weight: 4, diff: 4, hours: 3, tags: ['大题'] }
      ]},
      { id: 'ds2', name: '栈、队列和数组', points: [
        { id: 'ds2-1', name: '栈的定义、顺序栈与链栈', weight: 4, diff: 2, hours: 2 },
        { id: 'ds2-2', name: '栈的应用（括号匹配/表达式求值/递归）', weight: 5, diff: 3, hours: 3, tags: ['必考'] },
        { id: 'ds2-3', name: '队列的定义、顺序队列与链队列', weight: 4, diff: 2, hours: 2 },
        { id: 'ds2-4', name: '循环队列与双端队列', weight: 4, diff: 3, hours: 2, tags: ['易错'] },
        { id: 'ds2-5', name: '特殊矩阵的压缩存储（对称/三角/三对角/稀疏）', weight: 4, diff: 3, hours: 2, tags: ['易错'] }
      ]},
      { id: 'ds3', name: '树与二叉树', points: [
        { id: 'ds3-1', name: '树的基本概念与性质', weight: 3, diff: 2, hours: 1.5 },
        { id: 'ds3-2', name: '二叉树的性质与存储结构', weight: 4, diff: 2, hours: 2 },
        { id: 'ds3-3', name: '二叉树遍历（先/中/后/层序）与递归非递归实现', weight: 5, diff: 4, hours: 4, tags: ['必考', '大题'] },
        { id: 'ds3-4', name: '由遍历序列确定二叉树', weight: 5, diff: 3, hours: 2, tags: ['必考'] },
        { id: 'ds3-5', name: '线索二叉树', weight: 3, diff: 3, hours: 2 },
        { id: 'ds3-6', name: '树与森林的转换及遍历', weight: 4, diff: 3, hours: 2 },
        { id: 'ds3-7', name: '哈夫曼树与哈夫曼编码', weight: 5, diff: 3, hours: 2.5, tags: ['必考'] },
        { id: 'ds3-8', name: '并查集', weight: 3, diff: 3, hours: 2 }
      ]},
      { id: 'ds4', name: '图', points: [
        { id: 'ds4-1', name: '图的基本概念（度/连通性/生成树）', weight: 3, diff: 2, hours: 2 },
        { id: 'ds4-2', name: '图的存储（邻接矩阵/邻接表/十字链表/邻接多重表）', weight: 4, diff: 3, hours: 3 },
        { id: 'ds4-3', name: '图的深度优先遍历 DFS', weight: 4, diff: 3, hours: 2 },
        { id: 'ds4-4', name: '图的广度优先遍历 BFS', weight: 4, diff: 3, hours: 2 },
        { id: 'ds4-5', name: '最小生成树（Prim / Kruskal）', weight: 5, diff: 4, hours: 3, tags: ['必考'] },
        { id: 'ds4-6', name: '最短路径（Dijkstra / Floyd）', weight: 5, diff: 5, hours: 4, tags: ['必考', '难点'] },
        { id: 'ds4-7', name: '拓扑排序', weight: 4, diff: 3, hours: 2, tags: ['常考'] },
        { id: 'ds4-8', name: '关键路径', weight: 5, diff: 5, hours: 3, tags: ['必考', '难点'] }
      ]},
      { id: 'ds5', name: '查找', points: [
        { id: 'ds5-1', name: '顺序查找与折半查找及ASL分析', weight: 4, diff: 3, hours: 2.5 },
        { id: 'ds5-2', name: '分块查找', weight: 3, diff: 2, hours: 1.5 },
        { id: 'ds5-3', name: 'B树与B+树（插入/删除/性质）', weight: 5, diff: 5, hours: 4, tags: ['必考', '难点'] },
        { id: 'ds5-4', name: '散列表：构造、冲突处理、ASL计算', weight: 5, diff: 4, hours: 3.5, tags: ['必考'] }
      ]},
      { id: 'ds6', name: '排序', points: [
        { id: 'ds6-1', name: '插入排序与希尔排序', weight: 4, diff: 3, hours: 2.5 },
        { id: 'ds6-2', name: '冒泡排序与快速排序（含Partition过程）', weight: 5, diff: 4, hours: 3.5, tags: ['必考'] },
        { id: 'ds6-3', name: '简单选择排序与堆排序（建堆/调整）', weight: 5, diff: 4, hours: 3, tags: ['必考'] },
        { id: 'ds6-4', name: '归并排序与基数排序', weight: 4, diff: 3, hours: 2.5 },
        { id: 'ds6-5', name: '外部排序与多路平衡归并、败者树', weight: 3, diff: 4, hours: 2.5 },
        { id: 'ds6-6', name: '各排序算法比较（时间/空间/稳定性）', weight: 5, diff: 2, hours: 1.5, tags: ['必考', '送分'] }
      ]}
    ]
  },
  {
    id: 'co', name: '计算机组成原理', score: 45, color: '#059669',
    chapters: [
      { id: 'co1', name: '计算机系统概述', points: [
        { id: 'co1-1', name: '计算机发展历程、分类与冯·诺依曼结构', weight: 3, diff: 1, hours: 1.5 },
        { id: 'co1-2', name: '计算机性能指标（主频/CPI/MIPS/加速比）', weight: 4, diff: 3, hours: 2, tags: ['常考'] }
      ]},
      { id: 'co2', name: '数据的表示和运算', points: [
        { id: 'co2-1', name: '进位计数制及相互转换', weight: 3, diff: 2, hours: 1.5 },
        { id: 'co2-2', name: '定点数原码/反码/补码/移码表示与转换', weight: 5, diff: 3, hours: 3, tags: ['必考'] },
        { id: 'co2-3', name: '定点数移位运算与加减运算、溢出判断', weight: 5, diff: 4, hours: 3, tags: ['必考'] },
        { id: 'co2-4', name: '定点数乘除法运算（原码/补码一位乘、Booth）', weight: 4, diff: 5, hours: 4, tags: ['难点'] },
        { id: 'co2-5', name: '浮点数表示（IEEE 754 单双精度）', weight: 5, diff: 4, hours: 3.5, tags: ['必考'] },
        { id: 'co2-6', name: '浮点数加减运算与舍入', weight: 4, diff: 5, hours: 3, tags: ['难点'] },
        { id: 'co2-7', name: '校验码：奇偶校验/海明码/CRC', weight: 4, diff: 4, hours: 3, tags: ['易错'] },
        { id: 'co2-8', name: 'ALU 与加法器（串行/并行进位）', weight: 3, diff: 3, hours: 2 }
      ]},
      { id: 'co3', name: '存储系统', points: [
        { id: 'co3-1', name: '存储器分类与层次结构、局部性原理', weight: 3, diff: 2, hours: 1.5 },
        { id: 'co3-2', name: 'SRAM/DRAM/ROM 特性与刷新', weight: 4, diff: 3, hours: 2, tags: ['常考'] },
        { id: 'co3-3', name: '主存扩展（位扩展/字扩展）与地址计算', weight: 5, diff: 4, hours: 3.5, tags: ['必考'] },
        { id: 'co3-4', name: 'Cache 工作原理与命中率计算', weight: 5, diff: 4, hours: 3, tags: ['必考'] },
        { id: 'co3-5', name: 'Cache 三种映射方式（直接/全相联/组相联）地址划分', weight: 5, diff: 5, hours: 4, tags: ['必考', '难点'] },
        { id: 'co3-6', name: 'Cache 替换算法与写策略（写回/写直达、写分配）', weight: 4, diff: 4, hours: 3 },
        { id: 'co3-7', name: '虚拟存储器、页表与地址转换', weight: 4, diff: 4, hours: 3, tags: ['常考'] },
        { id: 'co3-8', name: 'TLB、Cache、页表三级访存综合', weight: 5, diff: 5, hours: 4, tags: ['必考', '难点'] },
        { id: 'co3-9', name: '外存储器：磁盘结构与SSD', weight: 3, diff: 3, hours: 2 }
      ]},
      { id: 'co4', name: '指令系统', points: [
        { id: 'co4-1', name: '指令格式与操作码扩展', weight: 4, diff: 3, hours: 2.5, tags: ['常考'] },
        { id: 'co4-2', name: '寻址方式（立即/直接/间接/寄存器/变址/相对/基址）', weight: 5, diff: 4, hours: 3.5, tags: ['必考'] },
        { id: 'co4-3', name: '高级语言与机器级代码表示、汇编阅读', weight: 4, diff: 4, hours: 3.5, tags: ['难点'] },
        { id: 'co4-4', name: 'CISC 与 RISC 对比', weight: 3, diff: 1, hours: 1 }
      ]},
      { id: 'co5', name: '中央处理器', points: [
        { id: 'co5-1', name: 'CPU 功能与基本结构、寄存器组织', weight: 3, diff: 2, hours: 2 },
        { id: 'co5-2', name: '指令周期、机器周期与时钟周期', weight: 4, diff: 3, hours: 2.5, tags: ['常考'] },
        { id: 'co5-3', name: '数据通路与指令执行流程分析', weight: 5, diff: 5, hours: 4, tags: ['必考', '难点'] },
        { id: 'co5-4', name: '控制器：硬布线 vs 微程序', weight: 4, diff: 4, hours: 3 },
        { id: 'co5-5', name: '指令流水线原理与性能计算', weight: 5, diff: 4, hours: 3.5, tags: ['必考'] },
        { id: 'co5-6', name: '流水线冒险：结构冒险/数据冒险/控制冒险与转发', weight: 5, diff: 5, hours: 4, tags: ['必考', '难点'] },
        { id: 'co5-7', name: '超标量与动态流水线基础', weight: 3, diff: 4, hours: 2 },
        { id: 'co5-8', name: '异常和中断机制', weight: 4, diff: 4, hours: 3, tags: ['常考'] },
        { id: 'co5-9', name: '多处理器基本概念（SISD/SIMD/MIMD）', weight: 2, diff: 3, hours: 1.5 }
      ]},
      { id: 'co6', name: '总线', points: [
        { id: 'co6-1', name: '总线概念、分类与性能指标', weight: 3, diff: 2, hours: 1.5 },
        { id: 'co6-2', name: '总线仲裁与总线操作定时', weight: 3, diff: 3, hours: 2 }
      ]},
      { id: 'co7', name: '输入/输出系统', points: [
        { id: 'co7-1', name: 'I/O 接口与端口编址（统一/独立编址）', weight: 3, diff: 3, hours: 2 },
        { id: 'co7-2', name: '程序查询方式与程序中断方式', weight: 5, diff: 4, hours: 3, tags: ['必考'] },
        { id: 'co7-3', name: '中断处理流程与多重中断、中断屏蔽字', weight: 5, diff: 5, hours: 3.5, tags: ['必考', '难点'] },
        { id: 'co7-4', name: 'DMA 方式（三种传送方式与周期挪用）', weight: 5, diff: 4, hours: 3, tags: ['必考'] }
      ]}
    ]
  },
  {
    id: 'os', name: '操作系统', score: 35, color: '#d97706',
    chapters: [
      { id: 'os1', name: '操作系统概述', points: [
        { id: 'os1-1', name: '操作系统的概念、特征与功能', weight: 3, diff: 1, hours: 1.5 },
        { id: 'os1-2', name: '操作系统发展历程与分类', weight: 2, diff: 1, hours: 1 },
        { id: 'os1-3', name: '运行机制：内核态/用户态、中断与系统调用', weight: 4, diff: 3, hours: 2.5, tags: ['常考'] },
        { id: 'os1-4', name: '操作系统结构（大内核/微内核/模块化）', weight: 3, diff: 2, hours: 1.5 }
      ]},
      { id: 'os2', name: '进程与处理机管理', points: [
        { id: 'os2-1', name: '进程的概念、组成与状态转换', weight: 4, diff: 2, hours: 2 },
        { id: 'os2-2', name: '进程控制与 PCB、原语', weight: 4, diff: 3, hours: 2.5 },
        { id: 'os2-3', name: '进程通信（共享内存/消息传递/管道）', weight: 3, diff: 2, hours: 2 },
        { id: 'os2-4', name: '线程概念、实现方式与多线程模型', weight: 4, diff: 3, hours: 2.5 },
        { id: 'os2-5', name: '处理机调度层次与评价指标', weight: 4, diff: 3, hours: 2.5 },
        { id: 'os2-6', name: '调度算法（FCFS/SJF/RR/优先级/多级反馈队列）', weight: 5, diff: 4, hours: 3.5, tags: ['必考'] },
        { id: 'os2-7', name: '同步与互斥、临界区、Peterson 算法', weight: 5, diff: 4, hours: 3, tags: ['必考'] },
        { id: 'os2-8', name: '信号量机制与 P、V 操作', weight: 5, diff: 5, hours: 4, tags: ['必考', '难点'] },
        { id: 'os2-9', name: '经典同步问题（生产者消费者/读者写者/哲学家进餐）', weight: 5, diff: 5, hours: 4, tags: ['必考', '大题'] },
        { id: 'os2-10', name: '管程', weight: 3, diff: 3, hours: 2 },
        { id: 'os2-11', name: '死锁概念、产生条件与处理策略', weight: 4, diff: 3, hours: 2.5 },
        { id: 'os2-12', name: '银行家算法与安全序列', weight: 5, diff: 4, hours: 3, tags: ['必考'] }
      ]},
      { id: 'os3', name: '内存管理', points: [
        { id: 'os3-1', name: '内存管理概念、逻辑与物理地址、重定位', weight: 4, diff: 3, hours: 2.5 },
        { id: 'os3-2', name: '连续分配管理方式与动态分区分配算法', weight: 4, diff: 3, hours: 2.5 },
        { id: 'os3-3', name: '基本分页管理、页表与地址变换', weight: 5, diff: 4, hours: 3.5, tags: ['必考'] },
        { id: 'os3-4', name: '基本分段与段页式管理', weight: 4, diff: 3, hours: 2.5 },
        { id: 'os3-5', name: '虚拟内存概念与请求分页、缺页处理', weight: 5, diff: 4, hours: 3.5, tags: ['必考'] },
        { id: 'os3-6', name: '页面置换算法（OPT/FIFO/LRU/CLOCK）与缺页率计算', weight: 5, diff: 5, hours: 4, tags: ['必考', '难点'] },
        { id: 'os3-7', name: '工作集、抖动与内存映射文件', weight: 3, diff: 3, hours: 2 }
      ]},
      { id: 'os4', name: '文件管理', points: [
        { id: 'os4-1', name: '文件概念、逻辑结构与文件操作', weight: 3, diff: 2, hours: 2 },
        { id: 'os4-2', name: '目录结构（树形目录、索引结点）', weight: 4, diff: 3, hours: 2.5 },
        { id: 'os4-3', name: '文件共享与保护', weight: 3, diff: 2, hours: 1.5 },
        { id: 'os4-4', name: '文件系统实现与文件分配方式（连续/链接/索引）', weight: 5, diff: 4, hours: 3.5, tags: ['必考'] },
        { id: 'os4-5', name: '空闲空间管理与混合索引寻址计算', weight: 5, diff: 5, hours: 3.5, tags: ['必考', '难点'] },
        { id: 'os4-6', name: '磁盘结构与磁盘调度算法', weight: 4, diff: 3, hours: 3, tags: ['常考'] }
      ]},
      { id: 'os5', name: '输入/输出管理', points: [
        { id: 'os5-1', name: 'I/O 管理概述与 I/O 软件层次结构', weight: 3, diff: 2, hours: 2 },
        { id: 'os5-2', name: '设备独立性与设备分配', weight: 3, diff: 3, hours: 2 },
        { id: 'os5-3', name: '缓冲技术、缓存与SPOOLing', weight: 4, diff: 3, hours: 2.5, tags: ['常考'] }
      ]}
    ]
  },
  {
    id: 'cn', name: '计算机网络', score: 25, color: '#7c3aed',
    chapters: [
      { id: 'cn1', name: '计算机网络体系结构', points: [
        { id: 'cn1-1', name: '计算机网络概念、组成、功能与分类', weight: 2, diff: 1, hours: 1 },
        { id: 'cn1-2', name: '性能指标（速率/带宽/时延/时延带宽积/RTT）', weight: 4, diff: 3, hours: 2.5, tags: ['常考'] },
        { id: 'cn1-3', name: 'OSI 七层模型与 TCP/IP 模型', weight: 4, diff: 2, hours: 2 },
        { id: 'cn1-4', name: '分层思想、协议、接口与服务', weight: 3, diff: 2, hours: 1.5 }
      ]},
      { id: 'cn2', name: '物理层', points: [
        { id: 'cn2-1', name: '物理层基本概念与数据通信基础', weight: 3, diff: 2, hours: 1.5 },
        { id: 'cn2-2', name: '奈奎斯特定理与香农定理', weight: 4, diff: 3, hours: 2, tags: ['常考'] },
        { id: 'cn2-3', name: '编码与调制（曼彻斯特/差分曼彻斯特）', weight: 3, diff: 3, hours: 2 },
        { id: 'cn2-4', name: '传输介质与中继器、集线器', weight: 2, diff: 1, hours: 1 },
        { id: 'cn2-5', name: '信道复用技术（FDM/TDM/WDM/CDMA）', weight: 3, diff: 3, hours: 2 }
      ]},
      { id: 'cn3', name: '数据链路层', points: [
        { id: 'cn3-1', name: '数据链路层功能、组帧与透明传输', weight: 4, diff: 3, hours: 2.5 },
        { id: 'cn3-2', name: '差错控制、检错纠错与 ARQ 思想', weight: 4, diff: 3, hours: 2.5 },
        { id: 'cn3-3', name: '流量控制与滑动窗口、停止等待协议', weight: 5, diff: 4, hours: 3, tags: ['必考'] },
        { id: 'cn3-4', name: '后退 N 帧与选择重传协议（窗口与序号计算）', weight: 5, diff: 5, hours: 4, tags: ['必考', '难点'] },
        { id: 'cn3-5', name: '介质访问控制与 CSMA/CD、退避算法', weight: 5, diff: 4, hours: 3, tags: ['必考'] },
        { id: 'cn3-6', name: '以太网、MAC 帧格式与最小帧长', weight: 5, diff: 4, hours: 3, tags: ['必考'] },
        { id: 'cn3-7', name: '交换机、网桥与 VLAN', weight: 4, diff: 3, hours: 2.5 },
        { id: 'cn3-8', name: '无线局域网与 CSMA/CA、PPP 协议', weight: 3, diff: 3, hours: 2 }
      ]},
      { id: 'cn4', name: '网络层', points: [
        { id: 'cn4-1', name: '网络层功能与路由转发原理', weight: 3, diff: 2, hours: 2 },
        { id: 'cn4-2', name: 'IPv4 分组格式与分片计算', weight: 5, diff: 4, hours: 3, tags: ['必考'] },
        { id: 'cn4-3', name: 'IP 地址、子网划分与 CIDR、地址块计算', weight: 5, diff: 5, hours: 4, tags: ['必考', '难点'] },
        { id: 'cn4-4', name: 'ARP、DHCP 与 ICMP', weight: 4, diff: 3, hours: 2.5, tags: ['常考'] },
        { id: 'cn4-5', name: 'IPv6 与 NAT', weight: 3, diff: 2, hours: 2 },
        { id: 'cn4-6', name: '路由协议 RIP 与距离向量算法', weight: 4, diff: 4, hours: 2.5, tags: ['常考'] },
        { id: 'cn4-7', name: '路由协议 OSPF、BGP 与自治系统', weight: 3, diff: 3, hours: 2 },
        { id: 'cn4-8', name: 'IP 组播与移动 IP', weight: 2, diff: 3, hours: 1.5 }
      ]},
      { id: 'cn5', name: '传输层', points: [
        { id: 'cn5-1', name: '传输层功能、端口与复用分用', weight: 3, diff: 2, hours: 2 },
        { id: 'cn5-2', name: 'UDP 特点、首部与适用场景', weight: 3, diff: 2, hours: 2 },
        { id: 'cn5-3', name: 'TCP 报文段格式与首部字段', weight: 4, diff: 3, hours: 2.5, tags: ['常考'] },
        { id: 'cn5-4', name: 'TCP 连接管理（三次握手与四次挥手、状态机）', weight: 5, diff: 4, hours: 3.5, tags: ['必考'] },
        { id: 'cn5-5', name: 'TCP 可靠传输与超时重传、快速重传', weight: 5, diff: 5, hours: 4, tags: ['必考', '难点'] },
        { id: 'cn5-6', name: 'TCP 流量控制与滑动窗口', weight: 4, diff: 4, hours: 2.5 },
        { id: 'cn5-7', name: 'TCP 拥塞控制（慢开始/拥塞避免/快重传/快恢复）', weight: 5, diff: 5, hours: 4, tags: ['必考', '难点'] }
      ]},
      { id: 'cn6', name: '应用层', points: [
        { id: 'cn6-1', name: 'C/S 与 P2P 模型、应用层协议概览', weight: 2, diff: 1, hours: 1 },
        { id: 'cn6-2', name: 'DNS 域名解析过程与递归迭代查询', weight: 4, diff: 3, hours: 2.5, tags: ['常考'] },
        { id: 'cn6-3', name: 'FTP、电子邮件（SMTP/POP3/IMAP）', weight: 3, diff: 2, hours: 2 },
        { id: 'cn6-4', name: 'WWW、HTTP 报文与响应状态码、缓存', weight: 4, diff: 3, hours: 2.5, tags: ['常考'] }
      ]}
    ]
  }
];

// ---- 展开为扁平结构并补齐字段 ----
const POINTS = [];
const CHAPTERS = [];
SUBJECTS.forEach((sub) => {
  sub.chapters.forEach((ch) => {
    ch.subjectId = sub.id;
    ch.pointIds = ch.points.map((p) => p.id);
    CHAPTERS.push(ch);
    ch.points.forEach((p, i) => {
      p.subjectId = sub.id;
      p.chapterId = ch.id;
      p.chapterName = ch.name;
      p.subjectName = sub.name;
      p.order = POINTS.length;
      if (!p.pre) p.pre = [];
      if (!p.tags) p.tags = [];
      if (i > 0 && p.pre.length === 0) p.pre = [ch.points[i - 1].id];
      POINTS.push(p);
    });
  });
});

const TOTAL_HOURS = POINTS.reduce((s, p) => s + p.hours, 0);

const SUBJECT_BY_ID = Object.fromEntries(SUBJECTS.map((s) => [s.id, s]));
const POINT_BY_ID = Object.fromEntries(POINTS.map((p) => [p.id, p]));
const CHAPTER_BY_ID = Object.fromEntries(CHAPTERS.map((c) => [c.id, c]));

module.exports = {
  SUBJECTS, CHAPTERS, POINTS, TOTAL_HOURS,
  SUBJECT_BY_ID, POINT_BY_ID, CHAPTER_BY_ID
};