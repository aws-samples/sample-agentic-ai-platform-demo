// Display-only, exact observed Gateway IDs matched to official endpoint/model-ID table cells.
// No wildcard, vendor inference, Runtime binding, entitlement, or approval inference.
export const MODEL_PROVIDER_FACTS = Object.freeze({
  "bedrock-mantle/anthropic.claude-haiku-4-5": {
    "provider": "Anthropic",
    "name": "Claude Haiku 4.5",
    "modelId": "anthropic.claude-haiku-4-5",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html",
    "input": [
      "Image",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/deepseek.v3.2": {
    "provider": "DeepSeek",
    "name": "DeepSeek V3.2",
    "modelId": "deepseek.v3.2",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-v3-2.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/deepseek.v3.1": {
    "provider": "DeepSeek",
    "name": "DeepSeek-V3.1",
    "modelId": "deepseek.v3.1",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-v3-1.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/google.gemma-4-31b": {
    "provider": "Google",
    "name": "Gemma 4 31B",
    "modelId": "google.gemma-4-31b",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-google-gemma-4-31b.html",
    "input": [
      "Image",
      "Text",
      "Video"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/google.gemma-4-26b-a4b": {
    "provider": "Google",
    "name": "Gemma 4 26B-A4B",
    "modelId": "google.gemma-4-26b-a4b",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-google-gemma-4-26b-a4b.html",
    "input": [
      "Image",
      "Text",
      "Video"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/google.gemma-4-e2b": {
    "provider": "Google",
    "name": "Gemma 4 E2B",
    "modelId": "google.gemma-4-e2b",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-google-gemma-4-e2b.html",
    "input": [
      "Audio",
      "Image",
      "Text",
      "Video"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/google.gemma-3-12b-it": {
    "provider": "Google",
    "name": "Gemma 3 12B IT",
    "modelId": "google.gemma-3-12b-it",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-google-gemma-3-12b-it.html",
    "input": [
      "Image",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/google.gemma-3-27b-it": {
    "provider": "Google",
    "name": "Gemma 3 27B PT",
    "modelId": "google.gemma-3-27b-it",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-google-gemma-3-27b-pt.html",
    "input": [
      "Image",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/google.gemma-3-4b-it": {
    "provider": "Google",
    "name": "Gemma 3 4B IT",
    "modelId": "google.gemma-3-4b-it",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-google-gemma-3-4b-it.html",
    "input": [
      "Image",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/minimax.minimax-m2.5": {
    "provider": "MiniMax",
    "name": "MiniMax M2.5",
    "modelId": "minimax.minimax-m2.5",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-5.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/minimax.minimax-m2.1": {
    "provider": "MiniMax",
    "name": "MiniMax M2.1",
    "modelId": "minimax.minimax-m2.1",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-1.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/minimax.minimax-m2": {
    "provider": "MiniMax",
    "name": "MiniMax M2",
    "modelId": "minimax.minimax-m2",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/mistral.ministral-3-14b-instruct": {
    "provider": "Mistral AI",
    "name": "Ministral 14B 3.0",
    "modelId": "mistral.ministral-3-14b-instruct",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-ministral-14b-3-0.html",
    "input": [
      "Image",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/mistral.devstral-2-123b": {
    "provider": "Mistral AI",
    "name": "Devstral 2 123B",
    "modelId": "mistral.devstral-2-123b",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-devstral-2-123b.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/mistral.magistral-small-2509": {
    "provider": "Mistral AI",
    "name": "Magistral Small 2509",
    "modelId": "mistral.magistral-small-2509",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-magistral-small-2509.html",
    "input": [
      "Image",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/mistral.ministral-3-8b-instruct": {
    "provider": "Mistral AI",
    "name": "Ministral 3 8B",
    "modelId": "mistral.ministral-3-8b-instruct",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-ministral-3-8b.html",
    "input": [
      "Image",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/mistral.ministral-3-3b-instruct": {
    "provider": "Mistral AI",
    "name": "Ministral 3B",
    "modelId": "mistral.ministral-3-3b-instruct",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-ministral-3b.html",
    "input": [
      "Image",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/mistral.mistral-large-3-675b-instruct": {
    "provider": "Mistral AI",
    "name": "Mistral Large 3",
    "modelId": "mistral.mistral-large-3-675b-instruct",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-mistral-large-3.html",
    "input": [
      "Image",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/mistral.voxtral-mini-3b-2507": {
    "provider": "Mistral AI",
    "name": "Voxtral Mini 3B 2507",
    "modelId": "mistral.voxtral-mini-3b-2507",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-voxtral-mini-3b-2507.html",
    "input": [
      "Speech",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/mistral.voxtral-small-24b-2507": {
    "provider": "Mistral AI",
    "name": "Voxtral Small 24B 2507",
    "modelId": "mistral.voxtral-small-24b-2507",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-voxtral-small-24b-2507.html",
    "input": [
      "Speech",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/moonshotai.kimi-k2.5": {
    "provider": "Moonshot AI",
    "name": "Kimi K2.5",
    "modelId": "moonshotai.kimi-k2.5",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-5.html",
    "input": [
      "Image",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/moonshotai.kimi-k2-thinking": {
    "provider": "Moonshot AI",
    "name": "Kimi K2 Thinking",
    "modelId": "moonshotai.kimi-k2-thinking",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-thinking.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/nvidia.nemotron-nano-12b-v2": {
    "provider": "NVIDIA",
    "name": "NVIDIA Nemotron Nano 12B v2 VL BF16",
    "modelId": "nvidia.nemotron-nano-12b-v2",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-nvidia-nvidia-nemotron-nano-12b-v2-vl-bf16.html",
    "input": [
      "Image",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/nvidia.nemotron-nano-9b-v2": {
    "provider": "NVIDIA",
    "name": "NVIDIA Nemotron Nano 9B v2",
    "modelId": "nvidia.nemotron-nano-9b-v2",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-nvidia-nvidia-nemotron-nano-9b-v2.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/nvidia.nemotron-nano-3-30b": {
    "provider": "NVIDIA",
    "name": "Nemotron Nano 3 30B",
    "modelId": "nvidia.nemotron-nano-3-30b",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-nvidia-nemotron-nano-3-30b.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/nvidia.nemotron-super-3-120b": {
    "provider": "NVIDIA",
    "name": "NVIDIA Nemotron 3 Super 120B",
    "modelId": "nvidia.nemotron-super-3-120b",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-nvidia-nemotron-super-3-120b.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/openai.gpt-5.6-terra": {
    "provider": "OpenAI",
    "name": "GPT-5.6 Terra",
    "modelId": "openai.gpt-5.6-terra",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-terra.html",
    "input": [
      "Image",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/openai.gpt-5.6-luna": {
    "provider": "OpenAI",
    "name": "GPT-5.6 Luna",
    "modelId": "openai.gpt-5.6-luna",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-luna.html",
    "input": [
      "Image",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/openai.gpt-5.4": {
    "provider": "OpenAI",
    "name": "GPT-5.4",
    "modelId": "openai.gpt-5.4",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-54.html",
    "input": [
      "Image",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/openai.gpt-oss-safeguard-120b": {
    "provider": "OpenAI",
    "name": "GPT OSS Safeguard 120B",
    "modelId": "openai.gpt-oss-safeguard-120b",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-safeguard-120b.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/openai.gpt-oss-safeguard-20b": {
    "provider": "OpenAI",
    "name": "GPT OSS Safeguard 20B",
    "modelId": "openai.gpt-oss-safeguard-20b",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-safeguard-20b.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/openai.gpt-oss-120b": {
    "provider": "OpenAI",
    "name": "gpt-oss-120b",
    "modelId": "openai.gpt-oss-120b",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-120b.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/openai.gpt-oss-20b": {
    "provider": "OpenAI",
    "name": "gpt-oss-20b",
    "modelId": "openai.gpt-oss-20b",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-20b.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/qwen.qwen3-235b-a22b-2507": {
    "provider": "Qwen",
    "name": "Qwen3 235B A22B 2507",
    "modelId": "qwen.qwen3-235b-a22b-2507",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-235b-a22b-2507.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/qwen.qwen3-32b": {
    "provider": "Qwen",
    "name": "Qwen3 32B",
    "modelId": "qwen.qwen3-32b",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-32b.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/qwen.qwen3-coder-480b-a35b-instruct": {
    "provider": "Qwen",
    "name": "Qwen3 Coder 480B A35B Instruct",
    "modelId": "qwen.qwen3-coder-480b-a35b-instruct",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-480b-a35b-instruct.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/qwen.qwen3-coder-next": {
    "provider": "Qwen",
    "name": "Qwen3 Coder Next",
    "modelId": "qwen.qwen3-coder-next",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-next.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/qwen.qwen3-next-80b-a3b-instruct": {
    "provider": "Qwen",
    "name": "Qwen3 Next 80B A3B",
    "modelId": "qwen.qwen3-next-80b-a3b-instruct",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-next-80b-a3b.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/qwen.qwen3-vl-235b-a22b-instruct": {
    "provider": "Qwen",
    "name": "Qwen3 VL 235B A22B",
    "modelId": "qwen.qwen3-vl-235b-a22b-instruct",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-vl-235b-a22b.html",
    "input": [
      "Image",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/qwen.qwen3-coder-30b-a3b-instruct": {
    "provider": "Qwen",
    "name": "Qwen3-Coder-30B-A3B-Instruct",
    "modelId": "qwen.qwen3-coder-30b-a3b-instruct",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-30b-a3b-instruct.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/writer.palmyra-vision-7b": {
    "provider": "Writer",
    "name": "Palmyra Vision 7B",
    "modelId": "writer.palmyra-vision-7b",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-writer-palmyra-vision-7b.html",
    "input": [
      "Image",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/xai.grok-4.3": {
    "provider": "xAI",
    "name": "Grok 4.3",
    "modelId": "xai.grok-4.3",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-xai-grok-4-3.html",
    "input": [
      "Image",
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/zai.glm-4.7": {
    "provider": "Z.AI",
    "name": "GLM 4.7",
    "modelId": "zai.glm-4.7",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-zai-glm-4-7.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/zai.glm-4.7-flash": {
    "provider": "Z.AI",
    "name": "GLM 4.7 Flash",
    "modelId": "zai.glm-4.7-flash",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-zai-glm-4-7-flash.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  },
  "bedrock-mantle/zai.glm-5": {
    "provider": "Z.AI",
    "name": "GLM 5",
    "modelId": "zai.glm-5",
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-zai-glm-5.html",
    "input": [
      "Text"
    ],
    "output": [
      "Text"
    ],
    "checkedAt": "2026-09-12"
  }
});
