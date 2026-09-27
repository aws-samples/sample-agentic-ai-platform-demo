#!/usr/bin/env python3
"""Generate a standalone draw.io architecture diagram for the agentic AI platform,
using AWS4 service stencils. Multi-account layout (Governance / Platform shared /
Domain dev-preprod-prod / Data Lake) in the style of the reference MLOps diagram
but with AgentCore + agentic services."""

import html

cells = []
_id = [10]
def nid():
    _id[0] += 1
    return f"n{_id[0]}"

def esc(s): return html.escape(s, quote=True)

def group(x, y, w, h, label, color, fill="none"):
    i = nid()
    style = (f"points=[[0,0],[0.25,0],[0.5,0],[0.75,0],[1,0],[1,0.25],[1,0.5],[1,0.75],"
             f"[1,1],[0.75,1],[0.5,1],[0.25,1],[0,1],[0,0.75],[0,0.5],[0,0.25]];"
             f"outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=13;fontStyle=1;"
             f"container=1;pointerEvents=0;collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;"
             f"grIcon=mxgraph.aws4.group_account;strokeColor={color};fillColor={fill};verticalAlign=top;"
             f"align=left;spacingLeft=30;fontColor={color};dashed=0;")
    cells.append(f'<mxCell id="{i}" value="{esc(label)}" style="{style}" vertex="1" parent="1">'
                 f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>')
    return i

def plainbox(x, y, w, h, label, parent="1", stroke="#5A6C86", fill="#F7F9FC", dashed=0, fontcolor="#232F3E", fontstyle=0):
    i = nid()
    style = (f"rounded=1;whiteSpace=wrap;html=1;fillColor={fill};strokeColor={stroke};dashed={dashed};"
             f"fontColor={fontcolor};fontSize=11;fontStyle={fontstyle};verticalAlign=middle;arcSize=12;")
    cells.append(f'<mxCell id="{i}" value="{esc(label)}" style="{style}" vertex="1" parent="{parent}">'
                 f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>')
    return i

def svc(x, y, label, res, parent="1", fill="#E7157B", w=48, h=48):
    """AWS resource icon with label under it."""
    i = nid()
    style = (f"sketch=0;points=[[0,0,0],[0.25,0,0],[0.5,0,0],[0.75,0,0],[1,0,0],[0,1,0],[0.25,1,0],"
             f"[0.5,1,0],[0.75,1,0],[1,1,0],[0,0.25,0],[0,0.5,0],[0,0.75,0],[1,0.25,0],[1,0.5,0],[1,0.75,0]];"
             f"outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor={fill};strokeColor=none;dashed=0;"
             f"verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=10;fontStyle=0;"
             f"aspect=fixed;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.{res};")
    cells.append(f'<mxCell id="{i}" value="{esc(label)}" style="{style}" vertex="1" parent="{parent}">'
                 f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>')
    return i

def persona(x, y, label, parent="1"):
    i = nid()
    style = ("sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=#232F3E;strokeColor=none;"
             "dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=10;fontStyle=0;"
             "aspect=fixed;shape=mxgraph.aws4.user;")
    cells.append(f'<mxCell id="{i}" value="{esc(label)}" style="{style}" vertex="1" parent="{parent}">'
                 f'<mxGeometry x="{x}" y="{y}" width="40" height="40" as="geometry"/></mxCell>')
    return i

def edge(src, dst, label="", color="#232F3E", dashed=0, style_extra=""):
    i = nid()
    style = (f"edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor={color};strokeWidth=1.5;"
             f"dashed={dashed};endArrow=block;endFill=1;fontSize=10;fontColor={color};{style_extra}")
    lbl = esc(label)
    cells.append(f'<mxCell id="{i}" value="{lbl}" style="{style}" edge="1" parent="1" source="{src}" target="{dst}">'
                 f'<mxGeometry relative="1" as="geometry"/></mxCell>')
    return i

def title(x, y, w, text, size=20):
    i = nid()
    style = (f"text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;"
             f"fontSize={size};fontStyle=1;fontColor=#232F3E;")
    cells.append(f'<mxCell id="{i}" value="{esc(text)}" style="{style}" vertex="1" parent="1">'
                 f'<mxGeometry x="{x}" y="{y}" width="{w}" height="34" as="geometry"/></mxCell>')
    return i

# palette
BR = "#E7157B"      # bedrock/ML pink
COMPUTE = "#ED7100" # orange
NET = "#8C4FFF"     # purple (app integration / networking)
SEC = "#DD344C"     # security red
STG = "#7AA116"     # storage green
MGMT = "#E7157B"
DEVT = "#C925D1"    # dev tools magenta

# ---------------- canvas ----------------
title(40, 20, 900, "Enterprise Agentic AI Platform — Multi-Account Architecture", 22)
title(40, 52, 1200, "Governed control plane (shared) + federated domain accounts (dev / pre-prod / prod) + durable data lake", 13)

# ===== GOVERNANCE / LANDING-ZONE ACCOUNT (left) =====
g_gov = group(40, 110, 300, 300, "Governance / Landing-Zone Account", "#CD2264")
svc(40, 60, "Service Catalog\n(account vending)", "service_catalog", parent=g_gov, fill=MGMT)
svc(190, 60, "CloudFormation\n(IaC)", "cloudformation", parent=g_gov, fill=MGMT)
svc(40, 165, "DynamoDB\nteam→account map", "dynamodb", parent=g_gov, fill=NET)
svc(190, 165, "IAM\ncross-account roles", "identity_and_access_management", parent=g_gov, fill=SEC)
persona(120, 250, "IT / Platform lead", parent=g_gov)

# ===== PLATFORM / SHARED SERVICES ACCOUNT (top center) — CONTROL PLANE =====
g_plat = group(360, 110, 780, 220, "Platform / Shared Services Account  ·  Control Plane (single pane of glass)", "#7D3AC1")
svc(40, 60, "AgentCore\nGateway", "bedrock", parent=g_plat, fill=BR)
svc(170, 60, "Agent & Tool\nRegistry", "bedrock", parent=g_plat, fill=BR)
svc(300, 60, "AgentCore\nIdentity", "cognito", parent=g_plat, fill=SEC)
svc(430, 60, "Evaluation\npipeline", "bedrock", parent=g_plat, fill=BR)
svc(560, 60, "CloudWatch\nobservability", "cloudwatch", parent=g_plat, fill=MGMT)
svc(680, 60, "Cedar policy\n+ Guardrails", "identity_and_access_management", parent=g_plat, fill=SEC)
plainbox(40, 150, 700, 40, "Blueprint catalog (Foundation Harness templates)  ·  Bedrock model catalog  ·  cost & token attribution",
         parent=g_plat, fill="#F2E9FB", stroke="#7D3AC1", fontcolor="#5B2A9A")

# ===== CI/CD (center band) =====
g_cicd = group(360, 350, 780, 150, "Golden-Path CI/CD  (agent-as-code in Git)", "#3184C2")
svc(40, 55, "CodeCommit\nrepo", "codecommit", parent=g_cicd, fill=DEVT)
svc(170, 55, "CodePipeline", "codepipeline", parent=g_cicd, fill=DEVT)
svc(300, 55, "CodeBuild\nscan·test·eval", "codebuild", parent=g_cicd, fill=DEVT)
svc(430, 55, "ECR\ncontainer images", "elastic_container_registry", parent=g_cicd, fill=COMPUTE)
plainbox(560, 55, 180, 48, "Manual approval gate\n(SME / product owner)", parent=g_cicd, fill="#FFF4E5", stroke="#ED7100", fontcolor="#B35A00")

# ===== DOMAIN ACCOUNT — environments (bottom) =====
def env_account(x, label, color, envtag, extra=""):
    g = group(x, 540, 250, 300, label, color)
    svc(40, 55, "AgentCore\nRuntime", "bedrock", parent=g, fill=BR)
    svc(160, 55, "AgentCore\nMemory", "bedrock", parent=g, fill=BR)
    svc(40, 150, "Lambda\ntools", "lambda", parent=g, fill=COMPUTE)
    svc(160, 150, "API Gateway", "api_gateway", parent=g, fill=NET)
    plainbox(40, 240, 170, 34, envtag, parent=g, fill="#EAF2FB", stroke=color, fontcolor=color, dashed=1)
    return g

g_dev  = env_account(330, "Domain Account · DEV", "#2E7D32", "synthetic data · guardrails: warn")
g_pre  = env_account(620, "Domain Account · PRE-PROD (UAT)", "#B36A00", "PII-masked · prod-parity · SME sign-off")
g_prod = env_account(910, "Domain Account · PROD", "#1565C0", "real data · canary/blue-green · HITL")

# ===== DATA LAKE (durable, bottom right) =====
g_data = group(1420, 540, 260, 300, "Data Lake Account  ·  Durable", "#5A6C86")
svc(40, 60, "Lake Formation\ndata governance", "lake_formation", parent=g_data, fill=STG)
svc(160, 60, "Amazon S3\ndatasets", "s3", parent=g_data, fill=STG)
svc(40, 165, "Knowledge Base\n+ vector store", "bedrock", parent=g_data, fill=BR)
svc(160, 165, "Glue\ningestion", "glue", parent=g_data, fill=NET)
persona(105, 250, "Data engineers", parent=g_data)

# ===== personas (far left) =====
persona(50, 470, "Domain developer")
persona(180, 470, "SME reviewer")

# ---------------- edges ----------------
# governance provisions platform + domain accounts
edge(g_gov, g_plat, "provisions & governs", color="#CD2264", dashed=1)
edge(g_gov, g_dev, "vends account set", color="#CD2264", dashed=1)
# ci/cd flow
edge(g_cicd, g_dev, "deploy", color="#2E7D32")
edge(g_dev, g_pre, "promote (eval gate)", color="#B36A00")
edge(g_pre, g_prod, "promote (approval)", color="#1565C0")
# domain envs route through control plane + trace up
edge(g_dev, g_plat, "route · register · trace ↑", color="#7D3AC1", dashed=1)
edge(g_prod, g_plat, "online eval · trace ↑", color="#7D3AC1", dashed=1)
# data lake feeds domains
edge(g_data, g_dev, "data (read)", color="#5A6C86", dashed=1)
edge(g_data, g_prod, "data (read)", color="#5A6C86", dashed=1)
# platform uses cicd
edge(g_plat, g_cicd, "blueprints → scaffold", color="#3184C2", dashed=1)

# ---------------- assemble ----------------
model = ('<mxGraphModel dx="1400" dy="900" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" '
         'arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="900" math="0" shadow="0">'
         '<root><mxCell id="0"/><mxCell id="1" parent="0"/>' + "".join(cells) + '</root></mxGraphModel>')

doc = ('<mxfile host="app.diagrams.net" agent="agentic-platform" version="24.0.0">'
       f'<diagram name="Agentic Platform Architecture" id="agentic-arch">{model}</diagram></mxfile>')

import sys
open(sys.argv[1], "w").write(doc)
print("wrote", sys.argv[1], "-", len(cells), "cells")
