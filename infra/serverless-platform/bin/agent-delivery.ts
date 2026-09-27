#!/usr/bin/env node
import * as fs from "node:fs";
import * as cdk from "aws-cdk-lib";
import {AgentDeliveryStack, AgentDeliveryTarget} from "../lib/agent-delivery-stack";
const file = process.env.AGENT_DELIVERY_CONFIG;
if (!file) throw new Error("AGENT_DELIVERY_CONFIG must name the reviewed account/repository bindings");
const target = JSON.parse(fs.readFileSync(file, "utf8")) as AgentDeliveryTarget;
new AgentDeliveryStack(new cdk.App(), "AgentDeliveryStack", target);
