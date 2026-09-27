#!/usr/bin/env python3
"""Generate aws-architecture.drawio using official AWS (AWS4/AWS25) shapes.

Layout is hand-placed with orthogonal wires and non-overlapping labels.
Run: python3 build_drawio.py            -> writes aws-architecture.drawio
Export: draw.io CLI renders it headlessly:
  /Applications/draw.io.app/Contents/MacOS/draw.io -x -f png -s 2 \
    -o aws-architecture.png aws-architecture.drawio
"""
import html

W, H = 2360, 1300
cells = []
_id = [1]


def lbl(s):
    """escape + newlines become <br>, itself XML-escaped inside the value attr."""
    return html.escape(s).replace("\n", "&lt;br&gt;")


def nid():
    _id[0] += 1
    return f"n{_id[0]}"


def box(x, y, w, h, label, stroke, fill="none", dashed=False, font=15, align="left", spacing=8):
    i = nid()
    style = (
        f"rounded=1;arcSize=2;whiteSpace=wrap;html=1;verticalAlign=top;align={align};"
        f"fontSize={font};fontStyle=1;fontColor={stroke};strokeColor={stroke};strokeWidth=2;"
        f"fillColor={fill};spacingLeft={spacing};spacingTop=4;"
    )
    if dashed:
        style += "dashed=1;dashPattern=8 6;"
    cells.append(
        f'<mxCell id="{i}" value="{lbl(label)}" style="{style}" vertex="1" parent="1">'
        f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>'
    )
    return i


def icon(x, y, label, shape, fill="#8C4FFF", w=64, h=64, font=13):
    """AWS resource icon + wrapped label underneath."""
    i = nid()
    style = (
        f"sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor={fill};"
        f"strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;"
        f"html=1;fontSize={font};fontStyle=0;aspect=fixed;whiteSpace=wrap;labelWidth=160;"
        f"shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.{shape};"
    )
    cells.append(
        f'<mxCell id="{i}" value="{lbl(label)}" style="{style}" vertex="1" parent="1">'
        f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>'
    )
    return i


def actor(x, y, label):
    i = nid()
    style = (
        "sketch=0;outlineConnect=0;fontColor=#232F3E;fillColor=#232F3E;strokeColor=none;"
        "verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=13;"
        "whiteSpace=wrap;labelWidth=160;shape=mxgraph.aws4.users;aspect=fixed;"
    )
    cells.append(
        f'<mxCell id="{i}" value="{lbl(label)}" style="{style}" vertex="1" parent="1">'
        f'<mxGeometry x="{x}" y="{y}" width="60" height="60" as="geometry"/></mxCell>'
    )
    return i


def wire(src, dst, label="", color="#545B64", dashed=False, width=2, exit_pt=None, entry_pt=None, fontcolor=None, loff=None):
    i = nid()
    style = (
        f"edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;"
        f"strokeColor={color};strokeWidth={width};fontSize=13;fontStyle=1;"
        f"fontColor={fontcolor or color};labelBackgroundColor=#FFFFFF;"
    )
    if dashed:
        style += "dashed=1;dashPattern=8 6;"
    if exit_pt:
        style += f"exitX={exit_pt[0]};exitY={exit_pt[1]};exitDx=0;exitDy=0;"
    if entry_pt:
        style += f"entryX={entry_pt[0]};entryY={entry_pt[1]};entryDx=0;entryDy=0;"
    geo = '<mxGeometry relative="1" as="geometry"/>'
    if loff:
        geo = (f'<mxGeometry relative="1" as="geometry">'
               f'<mxPoint as="offset" x="{loff[0]}" y="{loff[1]}"/></mxGeometry>')
    cells.append(
        f'<mxCell id="{i}" value="{lbl(label)}" style="{style}" edge="1" parent="1" '
        f'source="{src}" target="{dst}">{geo}</mxCell>'
    )
    return i


# ============================================================
# LAYER 0 — personas (left margin)
# ============================================================
builder = actor(40, 300, "Platform Admin ·\nDomain Lead · Builder")
enduser = actor(40, 620, "End User\n(chat + HITL feedback)")

# ============================================================
# SHARED PLATFORM ACCOUNT
# ============================================================
box(220, 40, 1180, 1180, "Shared Platform Account", "#E91E63", font=18)

# ---- Web plane ----
box(250, 90, 1120, 300, "Web plane — console + APIs (PlatformWebStack)", "#7B1FA2", fill="#FCFAFF", font=14)
cf = icon(300, 150, "CloudFront + S3\nconsole SPA", "cloudfront", "#8C4FFF")
api = icon(470, 150, "API Gateway\nHTTP API", "api_gateway", "#B0084D")
lam = icon(640, 150, "Lambda\nexperience · workspace\noperations · control-plane", "lambda_function", "#ED7100")
ddb = icon(880, 150, "DynamoDB\nplatform state · invocations\nHITL feedback ledger", "dynamodb", "#C925D1")
cog = icon(1120, 150, "Cognito user pool\nadmin · lead · builder\nend-user (SSO)", "cognito", "#DD344C")

# ---- Control plane (enriched) ----
box(250, 430, 1120, 420, "Control plane — governance + shared agent services (ControlPlane stack)", "#7B1FA2", fill="#FCFAFF", font=14)
reg = icon(300, 490, "AgentCore Registry\nagents · MCP tools ·\nblueprints · APPROVED gate", "bedrock", "#01A88D")
gw = icon(520, 490, "AgentCore Gateway\nmodel + tools inference", "bedrock", "#01A88D")
idn = icon(740, 490, "AgentCore Identity\nworkload identity ·\nOAuth providers", "bedrock", "#01A88D")
pol = icon(960, 490, "Policy engines\nCedar guardrails\nattach = compliance", "identity_and_access_management", "#DD344C")
gr = icon(1180, 490, "Bedrock Guardrails\ncontent filters · PII", "bedrock", "#01A88D")
gov = icon(300, 680, "Governance\napprovals · entitlements\naccess grants", "managed_workflows_for_apache_airflow", "#E7157B")
evals = icon(520, 680, "Evaluation service\nevaluators · golden\ndatasets · online eval", "sagemaker", "#01A88D")
bp = icon(740, 680, "Blueprints\nchatagent · workflowagent\nFoundation Harness", "cloudformation", "#E7157B")
cost = icon(960, 680, "Cost + usage\ntoken ledger ·\nbudgets per domain", "cost_explorer", "#E7157B")

# ---- Shared observability ----
box(250, 890, 1120, 290, "Shared observability", "#7B1FA2", fill="#FCFAFF", font=14)
cw = icon(430, 950, "CloudWatch\nGenAI spans · traces\nhitl-feedback stream", "cloudwatch", "#E7157B")
xr = icon(680, 950, "Transaction Search\nX-Ray trace\ndestination", "xray", "#E7157B")
ssm = icon(930, 950, "SSM Parameter Store\nLangfuse OTLP keys\n(2nd exporter)", "systems_manager", "#E7157B")

# ============================================================
# DOMAIN ACCOUNT — full project bootstrap
# ============================================================
box(1480, 40, 840, 620, "Domain Account — Customer Support (per-team account)", "#E91E63", font=18)
box(1510, 90, 780, 540, "Project bootstrap — everything agentcore deploy provisions (agentcore.json)", "#7B1FA2", fill="#FCFAFF", font=14)
rt = icon(1560, 150, "AgentCore Runtime\nchat_agent (Strands)\nCUSTOM_JWT authorizer", "bedrock", "#01A88D")
mem = icon(1790, 150, "AgentCore Memory\nsemantic · episodic\npreference · summary", "bedrock", "#01A88D")
kb = icon(2020, 150, "Knowledge Bases\ndomain documents\n+ S3 data sources", "bedrock", "#01A88D")
tools = icon(1560, 340, "Agent tools\ninline @tool · MCP via\nGateway targets", "bedrock", "#01A88D")
skl = icon(1790, 340, "Agent Skills\nSKILL.md modules\nprogressive disclosure", "bedrock", "#01A88D")
grd = icon(2020, 340, "Guardrail attach\npolicy engine binding\n(compliance gate)", "identity_and_access_management", "#DD344C")
iam = icon(1560, 500, "IAM execution roles\nruntime + memory\nleast privilege", "identity_and_access_management", "#DD344C")
ecr = icon(1790, 500, "Build artifacts\nCodeZip / container\n(CDK asset)", "codebuild", "#ED7100")
otel = icon(2020, 500, "OTEL exporter\nADOT auto-instrument\n+ telemetry.py", "cloudwatch", "#E7157B")

# ============================================================
# ENVIRONMENTS + PROMOTION
# ============================================================
box(1480, 720, 840, 500, "Environments per project — aws-targets.json (one CDK stack per env)", "#00897B", fill="#F4FBFA", dashed=True, font=15)
dev = icon(1560, 790, "DEV\nagentcore deploy\nlearn safely", "cloudformation", "#00897B")
pre = icon(1860, 790, "PRE-PROD\ngolden datasets\nevaluator runs", "cloudformation", "#00897B")
prd = icon(2160, 790, "PROD\nAPPROVED in registry\nvisible to End Users", "cloudformation", "#00897B")
gate = box(1560, 1010, 660, 170,
           "PROMOTION GATES\n• guardrail / policy engine attached (compliance)\n"
           "• evaluator pass on golden datasets\n• Domain Lead approval (governance)\n"
           "• publication review → registry APPROVED", "#00897B", fill="#FFFFFF", font=14, spacing=12)

# ============================================================
# WIRES — numbered main flow, orthogonal
# ============================================================
wire(builder, cf, "1  SSO sign-in", exit_pt=(1, 0.3), entry_pt=(0, 0.5))
wire(enduser, cf, "1  chat + rate", exit_pt=(1, 0.3), entry_pt=(0, 0.9))
wire(cf, api, exit_pt=(1, 0.5), entry_pt=(0, 0.5))
wire(api, lam, exit_pt=(1, 0.5), entry_pt=(0, 0.5))
wire(lam, ddb, exit_pt=(1, 0.5), entry_pt=(0, 0.5))
wire(lam, cog, "JWT verify", dashed=True, exit_pt=(1, 0.2), entry_pt=(0, 0.5))

wire(lam, rt, "2  InvokeAgentRuntime (CUSTOM_JWT bearer)", color="#E91E63", width=3,
     exit_pt=(0.5, 0), entry_pt=(0.35, 0))
wire(rt, gw, "3  Bedrock Converse via Gateway", color="#7B1FA2", width=2,
     exit_pt=(0, 0.7), entry_pt=(1, 0.3))
wire(pol, grd, "attach at deploy", color="#7B1FA2", dashed=True,
     exit_pt=(1, 0.5), entry_pt=(0, 0.5), loff=(-140, -14))
wire(rt, cw, "4  OTEL traces + hitl.feedback writeback", color="#00897B", width=3,
     exit_pt=(0, 0.9), entry_pt=(1, 0.3), loff=(120, 40))
wire(cw, lam, "5  project Observability tab (traces + feedback)", color="#00897B", dashed=True, width=2,
     exit_pt=(0.3, 0), entry_pt=(0.2, 1), loff=(160, 260))
wire(reg, lam, "APPROVED agents only", color="#E91E63", dashed=True,
     exit_pt=(0.5, 0), entry_pt=(0.5, 1))

wire(dev, pre, "gate", color="#00897B", exit_pt=(1, 0.5), entry_pt=(0, 0.5))
wire(pre, prd, "gate", color="#00897B", exit_pt=(1, 0.5), entry_pt=(0, 0.5))
wire(prd, reg, "6  registered APPROVED", color="#E91E63", dashed=True, width=2,
     exit_pt=(0.5, 1), entry_pt=(0.5, 1))

# ============================================================
# emit file
# ============================================================
body = "\n".join(cells)
doc = f'''<mxfile host="app.diagrams.net">
  <diagram id="arch" name="Platform architecture">
    <mxGraphModel dx="1000" dy="600" grid="0" gridSize="10" guides="1" tooltips="1" connect="1"
      arrows="1" fold="1" page="1" pageScale="1" pageWidth="{W}" pageHeight="{H}" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
{body}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>'''
with open("aws-architecture.drawio", "w") as f:
    f.write(doc)
print("wrote aws-architecture.drawio,", len(cells), "cells")
