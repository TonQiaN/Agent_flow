from pathlib import Path
import json, html, re, subprocess
ROOT=Path(__file__).resolve().parent
REPO=ROOT.parents[2]
KINDS=[
 dict(id='feature',name='功能与行为改进',short='功能',question='要新增或改变什么产品能力？',close='确认范围内的行为、契约和使用说明已实现并验证。',boundary='实现方案中的小范围探索和决策可同项完成；只有独立交付或阻塞其他工作时才拆分。'),
 dict(id='bug',name='缺陷与回归修复',short='缺陷',question='什么已约定的行为没有成立？',close='原失败条件下恢复约定行为，相关回归范围有证据。',boundary='尚未复现、根因未知仍可以是 Bug；不能用“研究完成”代替修复验收。'),
 dict(id='research',name='研究与证据验证',short='研究',question='哪个未知事实需要证据才能判断？',close='按预定方法回答有界问题，说明结论、证据限度与后续动作；结论可以是否定。',boundary='研究产物能独立验收；不要求为每项实现另建研究 Issue。'),
 dict(id='decision',name='方案与决策讨论',short='决策',question='团队现在需要选定什么及其边界？',close='形成自足的正式决定，记录真实比较、理由、确认范围和落实交接。',boundary='有主责和结束条件的讨论才是此类；开放式聊天与问答无需一律登记。'),
 dict(id='maintenance',name='工程与流程维护',short='维护',question='要落实什么工程、文档或协作改进？',close='指定工程结果和文档/配置已落地并完成适当验证。',boundary='不按文件扩展名分类；Prompt 改动也可能是功能或 Bug，模板和开发指令治理通常属于维护。'),
]

def field(id,label,description,placeholder='',required=True,type='textarea',options=None):
 d={'type':type,'id':id,'attributes':{'label':label,'description':description},'validations':{'required':required}}
 if placeholder:d['attributes']['placeholder']=placeholder
 if options is not None:d['attributes'].update(options=options,multiple=True)
 return d

COMMON_HEAD=[field('owner','主负责开发者','填写一名人类主责，并设置 GitHub Assignees；AI/工具可以协助，不能替代责任归属。','@GitHub 用户名；协作者及分工可另列。',type='input')]
COMMON_TAIL=[
 field('scope','范围与边界','写明本次交付切片、受影响模块/接口、保留行为与非目标；将必要事实写在正文，原始材料链接自愿提供。','包含：\n不包含：\n受影响模块/调用方：\n必须保持的行为：'),
 field('deliverables','预期交付物','可多选。每项在验收中指出具体内容/位置；选择“决策”不代表其他已承诺产物可省略。',type='dropdown',options=['正式决策正文','实现文件（代码 / 配置 / 模板）','当前说明或使用指南','研究 / 验证记录']),
 field('acceptance','验收标准与验证方式','列可检查的结果、方法和必要边界，不预填“通过”。研究/决策可以不运行产品测试；实际结果在执行后回填。','- [ ] 在……条件下，观察到……；以……验证。\n- [ ] 对应交付物……可检查，未知项……有处理结论。'),
 field('dependencies','依赖与阻塞','区分阻塞、相关参考和父子拆分。没有外部依赖写“无”；内部未知项写清由谁处理及何时影响下一步。','阻塞：无 / #Issue，所需交付：\n相关参考：\n父子关系（适用时）：'),
 field('decision_context','相关决定与待决问题','可先列候选稳定 ID 与问题，不要求创建时已完成决定。实施前按项目规则核对现行正文、alternatives/rejected；同一问题优先修订原文。','已有决定 / 当前依据：\n本次可能修订的问题：\n已知分歧或新证据：',required=False),
 field('handoff','整理与续接记录','创建时可留空，开始工作、实质变更或交接时补充。保持短摘要；具体确认与验证必须如实，空白不等于批准，已有授权不重复询问。','当前阶段 / 已完成：\n主责与实际参与分工：\n已确认范围、确认人/日期/依据：\n待决或阻塞与处理人：\n实际基线、证据位置及未验证部分：\n下一步 / 交接位置：',required=False),
]
SPEC={
 'feature':[
 field('problem','问题、场景与目标','说明使用者当前遇到的问题与希望得到的结果，避免只写实现技术或文件名。','谁在什么场景遇到什么限制？本次新增或改变什么能力？'),
 field('behavior_contract','行为与接口契约','用输入、期望输出、边界/失败情况描述新行为；适用时说明读写副作用、兼容性和权限需求。','正常例：输入 → 输出\n边界 / 失败例：\n接口 / 配置 / 兼容影响：')],
 'bug':[
 field('problem','实际与期望行为','给出失败现象及现行契约/已确认要求。区分观察与根因猜测，说明影响范围；未确定的期望标为待核对。','触发条件：\n实际结果：\n期望结果及依据：\n影响：'),
 field('reproduction','复现步骤与已有证据','写可执行步骤、最小输入、发生频次及尝试；未复现如实说明缺什么，不把假设写成根因。','1. ……\n最小输入/已有证据：\n重复次数与失败次数（实际值或未知）：\n已尝试及缺少条件：'),
 field('environment','版本与相关运行条件','只填与问题相关的提交/版本和条件。AgentFlow 运行问题分开记录 Harness、镜像依赖、节点 skill/MCP 配置与外围 I/O；不要求 agent 内部会话日志。','提交 / 产品版本：\nHarness 与版本（适用时）：\n镜像 / 物理依赖（适用时）：\n节点能力配置 / 脱敏输入输出（适用时）：\n未知项：')],
 'research':[
 field('problem','研究问题与决策用途','写清要减少哪项不确定性，以及证据将影响哪个功能、方案或开发安排。','要回答的问题：\n当前已知 / 未知：\n会影响的后续选择：'),
 field('evidence_plan','方法、比较与证据计划','写真实候选或假设、资料/实验方法、比较基线、关键控制条件及反例；单纯资料研究也需判断来源与适用版本。','候选 / 假设：\n资料或实验方法：\n基线、样本/版本与控制条件：\n可能推翻判断的结果：'),
 field('stop_rule','结束条件与投入边界','限定研究问题、时间/资源或样本边界；定义支持/不支持/仍不确定时分别交付什么，避免用“继续研究”无限延长。','结束条件：\n投入边界（按实际需要）：\n证据不足时的处理：\n结论去向 / 重开条件：')],
 'decision':[
 field('problem','需要敲定的问题与适用范围','说明为何现在要决定、影响谁，以及哪些要求已有明确确认。','要选择什么：\n已有确认 / 约束：\n本次仍待选择：'),
 field('options','候选方案与比较依据','比较真实存在的方案、代价和不改变现状的后果；已有否决理由优先引用。若仅有一种合理候选，解释原因，不编造替代方案。','方案及收益 / 代价：\n已有事实与证据限度：\n推荐及理由（未确认即建议）：'),
 field('impact','影响、落实与重开条件','说明对接口、文档、用户或开发流程的影响、实施交接，以及什么新事实值得重新讨论；决定被采纳不等于产品已实现。','影响范围 / 保留边界：\n落实去向（可待登记，不虚构 Issue 号）：\n是否还有必要研究：\n重开条件：')],
 'maintenance':[
 field('problem','当前问题与工程目标','说明维护原因和可观察改进；适用于重构、依赖升级、文档、测试设施、开发流程与模板。','当前问题：\n本次要落实的工程结果：'),
 field('change_plan','改动、兼容与验证计划','列受影响入口、必须保持的契约、适用的迁移/回退方式和验证方法；小文档任务可注明不涉及迁移。','改动范围与当前差异：\n保留行为 / 兼容：\n迁移或回退（不适用可说明）：\n验证方法：')],
}

FORMS={}
for kind in KINDS:
 k=kind['id']
 FORMS[k]={'name':kind['name'],'description':kind['question'],'title':'['+kind['short']+'] ',
 'body':[{'type':'markdown','attributes':{'value':'提交后按项目流程经人参与整理、预检和确认具体范围。请设置 Assignees；模板填写不是开工或验收证明。研究材料链接可选，正文必须自足。'}}]+COMMON_HEAD+SPEC[k]+COMMON_TAIL}

def ydump(x,indent=0):
 pad=' '*indent
 if isinstance(x,dict):
  out=[]
  for k,v in x.items():
   if isinstance(v,(dict,list)):
    out.append(pad+str(k)+':');out.extend(ydump(v,indent+2))
   else:out.append(pad+str(k)+': '+json.dumps(v,ensure_ascii=False))
  return out
 if isinstance(x,list):
  out=[]
  for v in x:
   if isinstance(v,(dict,list)):
    out.append(pad+'-');out.extend(ydump(v,indent+2))
   else:out.append(pad+'- '+json.dumps(v,ensure_ascii=False))
  return out
 raise ValueError(x)

def esc(s):return html.escape(str(s),quote=True)

def build():
 for k,form in FORMS.items():
  (ROOT/'draft-templates'/f'{k}.yml').write_text('# Issue #6 候选草案；未部署到 .github/ISSUE_TEMPLATE。\n'+'\n'.join(ydump(form))+'\n')
 (ROOT/'draft-templates/config.yml').write_text('# 沿用现有入口设置；不是提交权限或就绪门禁。\nblank_issues_enabled: false\n')
 (ROOT/'template-specs.json').write_text(json.dumps(FORMS,ensure_ascii=False,indent=2)+'\n')
 scenarios=json.loads((ROOT/'scenarios.json').read_text())
 examples=json.loads((ROOT/'examples.json').read_text())
 sections=[]
 for kind in KINDS:
  k=kind['id']; rows=[]
  for f in FORMS[k]['body']:
   if f['type']=='markdown':continue
   a=f['attributes']
   rows.append(f"| `{f['id']}` · {a['label']} | {'创建必填意图' if f['validations']['required'] else '按阶段补充'} | {a['description']} |")
  text=f'''<a id="template-{k}"></a>

### {kind['name']}

**核心问题：{kind['question']}** 完成条件：{kind['close']} {kind['boundary']}

[查看完整 YAML 候选](draft-templates/{k}.yml) · [对应填写演练](#example-{k})

| 字段 | 填写时点 | 内容与边界 |
| --- | --- | --- |
'''+ '\n'.join(rows)+'\n\n'
  text+='创建必填意图表示团队希望创建时具备的信息；当前私有仓库仍须人工就绪核对，不能据此声称 GitHub 会强制阻止提交。\n\n'
  sections.append(text)
  md=f"# [{kind['short']}] <具体问题或结果>\n\n工作性质：{kind['short']}\n\n"
  for f in FORMS[k]['body']:
   if f['type']=='markdown':continue
   a=f['attributes'];md+=f"## {a['label']}\n\n<!-- {a['description']} -->\n\n"
   if 'options' in a:md+='\n'.join('- [ ] '+o for o in a['options'])+'\n\n'
   else:md+=(a.get('placeholder','') or '按实际情况填写')+'\n\n'
  (ROOT/'draft-templates'/f'{k}.md').write_text(md)
 scenario_md='| 场景 | 性质 | 主分类 / 处理 | 应补信息与结束边界 |\n| --- | --- | --- | --- |\n'
 for s in scenarios:
  scenario_md+=f"| {s['id']} · {s['title']} | {s['basis']} | {s['route']} | {s['reason']}；{s['fields']} |\n"
 ex_md=[]
 for example in examples:
  title=example['title'];k=example['kind']; ident=example['id']
  body=f"# {title}\n\n**填写演练，不是真实 Issue 或执行结果。** {example['note']}\n\n"
  fields={f['id']:f for f in FORMS[k]['body'] if 'id' in f}
  for key,value in example['values'].items():body+=f"## {fields[key]['attributes']['label']}\n\n{value}\n\n"
  (ROOT/'examples'/f'{ident}.md').write_text(body)
  ex_md.append(f'<a id="example-{ident}"></a>\n\n<details>\n<summary>{esc(title)}</summary>\n\n'+body+'\n</details>\n\n')
 mapping=json.loads((ROOT/'candidate-mapping.json').read_text())
 mapping_md='| 原候选 | 本研究分类 | 判断依据 / 当前去向 |\n| --- | --- | --- |\n'
 for m in mapping:mapping_md+=f"| [{m['id']} · {m['title']}](../2026-09-08-high-level-and-issues/index.html#{m['id']}) | {m['kind']} | {m['reason']} |\n"
 report=(ROOT/'research-main.md').read_text().replace('{{TEMPLATE_SECTIONS}}','\n'.join(sections)).replace('{{SCENARIOS}}',scenario_md).replace('{{EXAMPLES}}','\n'.join(ex_md)).replace('{{MAPPING}}',mapping_md)
 (ROOT/'report.md').write_text(report.replace('<!--CHOOSER-->',''))
 frag=subprocess.run(['pandoc','-f','gfm','-t','html5','--wrap=none'],input=report,text=True,capture_output=True,check=True).stdout
 frag=re.sub(r'<table>.*?</table>',lambda m:'<div class="table-wrap" tabindex="0" role="region" aria-label="可横向滚动的表格">'+m.group(0)+'</div>',frag,flags=re.S)
 # Replace the scenario table with equally sourced, searchable cards in the reading page.
 cards=[]
 for s in scenarios:
  kinds=','.join(s['kinds'])
  search=esc(' '.join([s['id'],s['title'],s['basis'],s['route'],s['reason'],s['fields']]))
  cards.append(f'<details class="scenario" data-kinds="{kinds}" data-search="{search}" id="scenario-{s["id"]}"><summary><span class="sid">{s["id"]}</span><strong>{esc(s["title"])}</strong><span class="tag">{esc(s["route"])}</span></summary><div class="scenario-body"><p class="basis">{esc(s["basis"])}</p><p>{esc(s["reason"])}</p><p><b>应补内容：</b>{esc(s["fields"])}</p></div></details>')
 controls='<div class="filters"><label>搜索场景<input type="search" id="scenario-search" placeholder="例如 Prompt、交接、回放"></label><label>分类<select id="scenario-kind"><option value="all">全部</option>'+''.join(f'<option value="{k["id"]}">{k["short"]}</option>' for k in KINDS)+'<option value="none">不新建 Issue / 更新原项</option></select></label><button type="button" id="scenarios-expand">展开当前结果</button><button type="button" id="scenarios-reset">重置</button><span id="scenario-count" role="status" aria-live="polite">30 个场景</span></div><p id="no-scenarios" hidden>没有匹配场景，请调整筛选。</p>'
 table_html=subprocess.run(['pandoc','-f','gfm','-t','html5','--wrap=none'],input=scenario_md,text=True,capture_output=True,check=True).stdout.strip()
 wrapped='<div class="table-wrap" tabindex="0" role="region" aria-label="可横向滚动的表格">'+table_html+'</div>'
 assert wrapped in frag
 frag=frag.replace(wrapped,controls+'<div class="scenario-list">'+''.join(cards)+'</div>',1)
 navs=[('answer','确认与研究边界'),('current','研究时的基线快照'),('options','分类方案比较'),('routing','分类与拆分规则'),('scenarios','30 个协作场景'),('fields','共通字段与负担'),('maintenance-design','七项决定与存放设计'),('templates','五类模板内容'),('examples','填写演练'),('handoff','长周期协作与关闭'),('platform','GitHub 落地限制'),('mapping','原 25 项映射'),('delivery','Issue #6 落地与验收'),('sources','来源与局限')]
 nav=''.join(f'<a href="#{id}"><span>{n:02d}</span>{label}</a>' for n,(id,label) in enumerate(navs,1))
 css=(ROOT/'styles.css').read_text();js=(ROOT/'interactions.js').read_text()
 chooser='<div class="chooser"><label for="work-question">按主要完成条件定位模板</label><select id="work-question"><option value="">选择当前最需要回答的问题</option>'+''.join(f'<option value="{k["id"]}">{esc(k["question"])}</option>' for k in KINDS)+'</select><p id="chooser-result" aria-live="polite">这是分类辅助，不替代范围判断；混合工作按主结果分类。</p></div>'
 frag=frag.replace('<!--CHOOSER-->',chooser)
 page=f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>AgentFlow · Issue #6 分类与模板研究</title><style>{css}</style></head><body><a class="skip" href="#content">跳到正文</a><header><a href="#answer" class="brand">AgentFlow <small>ISSUE 06 / RESEARCH</small></a><div><span class="pill">已实施 · Issue #6 已关闭</span><a href="report.md">完整文本 ↗</a></div></header><div class="layout"><aside><div class="nav-title">研究导航</div><nav>{nav}</nav><div class="nav-note">5 类主工作项<br>7 份正式决定<br>30 个场景<br>12 份正式演练<br><a href="https://github.com/TonQiaN/Agent_flow/issues/6">Issue #6 ↗</a></div></aside><main id="content">{frag}</main></div><footer>2026-09-08 · 五类模板已实施并验证；本页保留研究与比较 · 外部链接需网络，正文与交互可离线使用</footer><script>{js}</script></body></html>'''
 (ROOT/'index.html').write_text(page)
 print(json.dumps({'templates':len(FORMS),'scenarios':len(scenarios),'examples':len(examples),'mapped_candidates':len(mapping),'html_bytes':len(page.encode()),'report_characters':len(report)},ensure_ascii=False))

if __name__=='__main__':build()
