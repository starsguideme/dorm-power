# -*- coding: utf-8 -*-
"""生成宿舍电费小账本的架构图（PNG）"""
import math
from PIL import Image, ImageDraw, ImageFont

OUT = r'C:/Users/20760/WorkBuddy/2026-10-26-14-44-40/apps/dorm-power/docs/架构图.png'
S = 2
W, H = 1180, 1060
FONT = r'C:\Windows\Fonts\msyh.ttc'
INK, MUTED, LINE = '#1A1A1A', '#6B7280', '#94A3B8'

def f(sz):
    return ImageFont.truetype(FONT, int(sz * S))

F_T, F_B, F_S, F_M = f(21), f(16), f(13), f(11)
img = Image.new('RGB', (W * S, H * S), '#FFFFFF')
d = ImageDraw.Draw(img)

def text(x, y, s, font, color=INK, anchor='la'):
    d.text((x*S, y*S), s, font=font, fill=color, anchor=anchor)

def box(x, y, w, h, title, subs=None, fill='#FFFFFF', stroke='#475569', radius=10,
        title_font=None, sub_font=None, top=False):
    d.rounded_rectangle([x*S, y*S, (x+w)*S, (y+h)*S], radius=radius*S,
                        fill=fill, outline=stroke, width=int(1.4*S))
    subs = subs or []
    if top:
        text(x + 16, y + 12, title, title_font or F_S)
        for i, s2 in enumerate(subs):
            text(x + 16, y + 34 + i*20, s2, sub_font or F_M, MUTED)
        return
    tf, sf = title_font or F_B, sub_font or F_S
    lines = [title] + subs
    lh = tf.size * 1.5
    total = lh * len(lines)
    for i, ln in enumerate(lines):
        ff = tf if i == 0 else sf
        tw = d.textlength(ln, font=ff)
        d.text(((x + w/2)*S - tw/2, (y + h/2)*S - total/2 + i*lh), ln, font=ff,
               fill=INK if i == 0 else MUTED)

def arrow(pts, label=None, lpos=None):
    for i in range(len(pts)-1):
        d.line([(pts[i][0]*S, pts[i][1]*S), (pts[i+1][0]*S, pts[i+1][1]*S)],
               fill=LINE, width=int(1.6*S))
    (x1, y1), (x2, y2) = pts[-2], pts[-1]
    ang = math.atan2(y2-y1, x2-x1)
    L, Wd = 10, 5
    d.polygon([(x2*S, y2*S),
               ((x2-L*math.cos(ang)+Wd*math.sin(ang))*S, (y2-L*math.sin(ang)-Wd*math.cos(ang))*S),
               ((x2-L*math.cos(ang)-Wd*math.sin(ang))*S, (y2-L*math.sin(ang)+Wd*math.cos(ang))*S)],
              fill=LINE)
    if label:
        lx, ly = lpos or ((x1+x2)/2, (y1+y2)/2 - 22)
        tw = d.textlength(label, font=F_S)
        text(lx*S - tw/2/S*0 + (lx - tw/2/S), ly, label, F_S, MUTED) if False else \
            d.text((lx*S - tw/2, ly*S), label, font=F_S, fill=MUTED)

# 标题
text(50, 34, '宿舍电费小账本 · 架构图', F_T)
text(50, 68, '零依赖 Node 单服务 · 双口令分权 · 每日定时推送（2026-11）', F_S, MUTED)
d.line([(50*S, 96*S), ((W-50)*S, 96*S)], fill='#E2E8F0', width=int(S))

# 用户层
text(50, 112, '用户层', F_M, '#94A3B8')
box(160, 108, 380, 96, '管理员（你）', ['管理口令登录', '看明细 / 录入 / 改设置'], '#EEF3FB', '#2B5C9B')
box(600, 108, 380, 96, '舍友（5 人）', ['舍友口令登录', '只看概览 · 可录读数'], '#E8F6EF', '#0F6E56')

# 接入层
text(50, 240, '接入层', F_M, '#94A3B8')
box(160, 234, 820, 76, '反向代理（平台域名 + sharecode）', ['HTTPS · 不带 sharecode 直接 403'], '#F8FAFC')
arrow([(350, 204), (350, 234)])
arrow([(790, 204), (790, 234)])

# 应用层（容器 + 六个能力块）
text(50, 348, '应用层', F_M, '#94A3B8')
d.rounded_rectangle([160*S, 342*S, 980*S, 604*S], radius=10*S, fill='#FFFFFF',
                    outline='#334155', width=int(1.4*S))
text(178, 352, 'Node 服务（server.js · 约 420 行 · 零依赖）', F_S)
arrow([(570, 310), (570, 342)])

blocks = [
    (182, 388, 240, 66, '静态页渲染', ['HTML + gzip', '内嵌首屏数据']),
    (442, 388, 240, 66, 'API 路由', ['14 个接口', 'GET / POST / DELETE']),
    (702, 388, 260, 66, '鉴权', ['ownerKey / guestKey', 'timingSafeEqual']),
    (182, 478, 240, 66, '双视图', ['owner: 全量', 'guest: 取整概览']),
    (442, 478, 240, 66, '计算', ['stats() 日均', 'estimate() 推算']),
    (702, 478, 260, 66, '定时与自唤醒', ['23:55–00:24 补发', '23:47/53/57 自唤醒']),
]
for x, y, w, h, t, s2 in blocks:
    box(x, y, w, h, t, s2, '#F8FAFC', '#CBD5E1', 8, F_S, F_M)

# 存储 / 外部
text(50, 636, '存储层', F_M, '#94A3B8')
box(160, 630, 380, 84, 'data.json（单文件）', ['记录 / 口令 / 阈值 / 人数', '写入：临时文件 + 原子重命名'], '#FEF9E7', '#8A5B0B')
arrow([(300, 604), (300, 630)], '读写', (258, 606))

box(600, 630, 380, 84, 'PushPlus API', ['微信服务号推送', '校验业务返回码 code'], '#FBEAF0', '#993556')
arrow([(790, 604), (790, 630)], 'HTTPS', (800, 596))

text(50, 766, '外部', F_M, '#94A3B8')
box(600, 760, 380, 76, '微信（你的手机）', ['每晚一条：余量 / 日均 / 断电日'], '#E8F6EF', '#0F6E56')
arrow([(790, 714), (790, 760)])

box(160, 760, 380, 76, '外部 cron（可选兜底）', ['每天 23:55 调 /api/cron?secret=', '请求可唤醒休眠容器'], '#F1F5F9', '#64748B')
arrow([(160, 798), (118, 798), (118, 508), (160, 508)], '外部调用', (128, 660))

# 说明
y0 = 884
d.line([(50*S, y0*S), ((W-50)*S, y0*S)], fill='#E2E8F0', width=int(S))
notes = [
    '① 数据来源：宿管每 7 天手工抄表 → 人工录入（学校未开放电控接口，19 号楼不在 i 太湖 覆盖范围）',
    '② 计算口径：日均 =（首读 − 近读）÷ 天数；估算余量 = 近读 − 日均 × 经过天数；断电日 = 今天 + 估算余量 ÷ 日均',
    '③ 权限边界：明细在服务端按身份裁剪，访客响应不含 records 字段；写接口越权返回 403 / 未初始化返回 428',
    '④ 告警阈值 = 日均 × 7 天（跑卡务中心 1 天 + 周末不办 + 缓冲），当前 12.6 × 7 ≈ 88 度',
]
for i, n in enumerate(notes):
    text(50, y0 + 24 + i*30, n, F_S, MUTED)

img.save(OUT, dpi=(300, 300))
print('saved', OUT, img.size)
