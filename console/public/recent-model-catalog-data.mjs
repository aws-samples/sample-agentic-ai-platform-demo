// Verified public-source catalog; evidence eligibility is not platform admission.
export const RECENT_MODEL_CATALOG = {
  "asOf": "2026-09-12",
  "window": {
    "start": "2026-03-12",
    "end": "2026-09-12",
    "inclusive": true,
    "basis": "vendor specific-version first formal release; preview excluded; staged formal launch explicitly annotated"
  },
  "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html",
  "sourceSha256": "f25a1704bfb4c7b05465eae3e8feb02eb9d75fa5bcabd095845c16fbb59cbd65",
  "models": [
    {
      "key": "openai-gpt-6-astra",
      "display_name": "GPT-6 Astra",
      "provider": "OpenAI",
      "provider_verified": true,
      "default_eligible": true,
      "eligibility_status": "eligible",
      "vendor_first_release_date": "2026-09-03",
      "bedrock_launch_date": "2026-09-08",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "image",
        "text"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": true,
      "runtime_api_support_confirmed": [
        "Responses",
        "Chat Completions",
        "Converse"
      ],
      "runtime_model_id": "openai.gpt-6-astra",
      "runtime_global_profile_id": "global.openai.gpt-6-astra",
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.html",
      "releaseSource": "https://openai.com/news/rss.xml",
      "releaseNote": "2026-09-03 is official launch/initial staged rollout, not a claim that every customer had GA access that day. Exact all-customer GA date not independently verified. 2026-09-09 article is follow-up, not first launch."
    },
    {
      "key": "anthropic-claude-opus-5",
      "display_name": "Claude Opus 5",
      "provider": "Anthropic",
      "provider_verified": true,
      "default_eligible": true,
      "eligibility_status": "eligible",
      "vendor_first_release_date": "2026-07-24",
      "bedrock_launch_date": "2026-07-24",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "image",
        "text"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": true,
      "runtime_api_support_confirmed": [
        "Messages",
        "Converse",
        "Invoke"
      ],
      "runtime_model_id": "anthropic.claude-opus-5",
      "runtime_global_profile_id": "global.anthropic.claude-opus-5",
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5.html",
      "releaseSource": "https://platform.claude.com/docs/en/release-notes/overview",
      "releaseNote": null
    },
    {
      "key": "anthropic-claude-sonnet-5",
      "display_name": "Claude Sonnet 5",
      "provider": "Anthropic",
      "provider_verified": true,
      "default_eligible": true,
      "eligibility_status": "eligible",
      "vendor_first_release_date": "2026-06-30",
      "bedrock_launch_date": "2026-06-30",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "image",
        "text"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": true,
      "runtime_api_support_confirmed": [
        "Messages",
        "Converse",
        "Invoke"
      ],
      "runtime_model_id": "anthropic.claude-sonnet-5",
      "runtime_global_profile_id": "global.anthropic.claude-sonnet-5",
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html",
      "releaseSource": "https://platform.claude.com/docs/en/release-notes/overview",
      "releaseNote": null
    },
    {
      "key": "xai-grok-4-6",
      "display_name": "Grok 4.6",
      "provider": "xAI",
      "provider_verified": true,
      "default_eligible": true,
      "eligibility_status": "eligible",
      "vendor_first_release_date": "2026-08-12",
      "bedrock_launch_date": "2026-08-18",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "image",
        "text"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": true,
      "runtime_api_support_confirmed": [
        "Responses",
        "Chat Completions",
        "Converse",
        "Invoke"
      ],
      "runtime_model_id": "xai.grok-4.6",
      "runtime_global_profile_id": "global.xai.grok-4.6",
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-xai-grok-4-6.html",
      "releaseSource": "https://x.ai/news/grok-4-6",
      "releaseNote": null
    },
    {
      "key": "anthropic-claude-haiku-4-5",
      "display_name": "Claude Haiku 4.5",
      "provider": "Anthropic",
      "provider_verified": true,
      "default_eligible": false,
      "eligibility_status": "excluded",
      "vendor_first_release_date": "2025-10-15",
      "bedrock_launch_date": "2025-10-16",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "image",
        "text"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": true,
      "runtime_api_support_confirmed": [
        "Messages",
        "Converse",
        "Invoke"
      ],
      "runtime_model_id": "anthropic.claude-haiku-4-5-20251001-v1:0",
      "runtime_global_profile_id": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html",
      "releaseSource": "https://platform.claude.com/docs/en/release-notes/overview",
      "releaseNote": null
    },
    {
      "key": "anthropic-claude-opus-4-8",
      "display_name": "Claude Opus 4.8",
      "provider": "Anthropic",
      "provider_verified": true,
      "default_eligible": true,
      "eligibility_status": "eligible",
      "vendor_first_release_date": "2026-05-28",
      "bedrock_launch_date": "2026-05-28",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "image",
        "text"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": true,
      "runtime_api_support_confirmed": [
        "Messages",
        "Converse",
        "Invoke"
      ],
      "runtime_model_id": "anthropic.claude-opus-4-8",
      "runtime_global_profile_id": "global.anthropic.claude-opus-4-8",
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-8.html",
      "releaseSource": "https://platform.claude.com/docs/en/release-notes/overview",
      "releaseNote": null
    },
    {
      "key": "anthropic-claude-opus-4-7",
      "display_name": "Claude Opus 4.7",
      "provider": "Anthropic",
      "provider_verified": true,
      "default_eligible": true,
      "eligibility_status": "eligible",
      "vendor_first_release_date": "2026-04-16",
      "bedrock_launch_date": "2026-04-16",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "image",
        "text"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": true,
      "runtime_api_support_confirmed": [
        "Messages",
        "Converse",
        "Invoke"
      ],
      "runtime_model_id": "anthropic.claude-opus-4-7",
      "runtime_global_profile_id": "global.anthropic.claude-opus-4-7",
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-7.html",
      "releaseSource": "https://platform.claude.com/docs/en/release-notes/overview",
      "releaseNote": null
    },
    {
      "key": "anthropic-claude-fable-5-1",
      "display_name": "Claude Fable 5.1",
      "provider": "Anthropic",
      "provider_verified": true,
      "default_eligible": true,
      "eligibility_status": "eligible",
      "vendor_first_release_date": "2026-09-01",
      "bedrock_launch_date": "2026-09-01",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "image",
        "text"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": true,
      "runtime_api_support_confirmed": [
        "Messages",
        "Converse",
        "Invoke"
      ],
      "runtime_model_id": "anthropic.claude-fable-5-1",
      "runtime_global_profile_id": "global.anthropic.claude-fable-5-1",
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-fable-5-1.html",
      "releaseSource": "https://platform.claude.com/docs/en/release-notes/overview",
      "releaseNote": null
    },
    {
      "key": "anthropic-claude-fable-5",
      "display_name": "Claude Fable 5",
      "provider": "Anthropic",
      "provider_verified": true,
      "default_eligible": true,
      "eligibility_status": "eligible",
      "vendor_first_release_date": "2026-06-09",
      "bedrock_launch_date": "2026-06-09",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "image",
        "text"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": true,
      "runtime_api_support_confirmed": [
        "Messages",
        "Converse",
        "Invoke"
      ],
      "runtime_model_id": "anthropic.claude-fable-5",
      "runtime_global_profile_id": "global.anthropic.claude-fable-5",
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-fable-5.html",
      "releaseSource": "https://platform.claude.com/docs/en/release-notes/overview",
      "releaseNote": null
    },
    {
      "key": "openai-gpt-56-sol",
      "display_name": "GPT-5.6 Sol",
      "provider": "OpenAI",
      "provider_verified": true,
      "default_eligible": true,
      "eligibility_status": "eligible",
      "vendor_first_release_date": "2026-07-09",
      "bedrock_launch_date": "2026-07-13",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "image",
        "text"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": true,
      "runtime_api_support_confirmed": [
        "Responses",
        "Chat Completions",
        "Converse"
      ],
      "runtime_model_id": "openai.gpt-5.6-sol",
      "runtime_global_profile_id": "global.openai.gpt-5.6-sol",
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-sol.html",
      "releaseSource": "https://openai.com/news/rss.xml",
      "releaseNote": null
    },
    {
      "key": "openai-gpt-55",
      "display_name": "GPT-5.5",
      "provider": "OpenAI",
      "provider_verified": true,
      "default_eligible": false,
      "eligibility_status": "excluded",
      "vendor_first_release_date": "2026-04-23",
      "bedrock_launch_date": "2026-06-01",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "image",
        "text"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": false,
      "runtime_api_support_confirmed": [],
      "runtime_model_id": null,
      "runtime_global_profile_id": null,
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-55.html",
      "releaseSource": "https://openai.com/news/rss.xml",
      "releaseNote": null
    },
    {
      "key": "google-gemma-4-31b",
      "display_name": "Gemma 4 31B",
      "provider": "Google",
      "provider_verified": true,
      "default_eligible": false,
      "eligibility_status": "excluded",
      "vendor_first_release_date": null,
      "bedrock_launch_date": "2026-03-31",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "image",
        "text",
        "video"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": false,
      "runtime_api_support_confirmed": [],
      "runtime_model_id": null,
      "runtime_global_profile_id": null,
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-google-gemma-4-31b.html",
      "releaseSource": null,
      "releaseNote": null
    },
    {
      "key": "nvidia-nemotron-super-3-120b",
      "display_name": "NVIDIA Nemotron 3 Super 120B",
      "provider": "NVIDIA",
      "provider_verified": true,
      "default_eligible": false,
      "eligibility_status": "excluded",
      "vendor_first_release_date": "2026-03-11",
      "bedrock_launch_date": "2026-03-11",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "text"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": true,
      "runtime_api_support_confirmed": [
        "Converse",
        "Invoke"
      ],
      "runtime_model_id": "nvidia.nemotron-super-3-120b",
      "runtime_global_profile_id": null,
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-nvidia-nemotron-super-3-120b.html",
      "releaseSource": "https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16/raw/main/README.md",
      "releaseNote": null
    },
    {
      "key": "mistral-ai-mistral-large-3",
      "display_name": "Mistral Large 3",
      "provider": "Mistral AI",
      "provider_verified": true,
      "default_eligible": false,
      "eligibility_status": "excluded",
      "vendor_first_release_date": null,
      "bedrock_launch_date": "2025-12-02",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "image",
        "text"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": true,
      "runtime_api_support_confirmed": [
        "Converse",
        "Invoke"
      ],
      "runtime_model_id": "mistral.mistral-large-3-675b-instruct",
      "runtime_global_profile_id": null,
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-mistral-large-3.html",
      "releaseSource": null,
      "releaseNote": null
    },
    {
      "key": "writer-palmyra-vision-7b",
      "display_name": "Palmyra Vision 7B",
      "provider": "Writer",
      "provider_verified": true,
      "default_eligible": false,
      "eligibility_status": "pending_verification",
      "vendor_first_release_date": null,
      "bedrock_launch_date": "2026-03-26",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "image",
        "text"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": true,
      "runtime_api_support_confirmed": [
        "Converse",
        "Invoke"
      ],
      "runtime_model_id": "writer.palmyra-vision-7b",
      "runtime_global_profile_id": null,
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-writer-palmyra-vision-7b.html",
      "releaseSource": null,
      "releaseNote": null
    },
    {
      "key": "amazon-nova-2-lite",
      "display_name": "Nova 2 Lite",
      "provider": "Amazon",
      "provider_verified": true,
      "default_eligible": false,
      "eligibility_status": "excluded",
      "vendor_first_release_date": "2025-12-02",
      "bedrock_launch_date": "2025-12-02",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "image",
        "text",
        "video"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": true,
      "runtime_api_support_confirmed": [
        "Converse",
        "Invoke"
      ],
      "runtime_model_id": "amazon.nova-2-lite-v1:0",
      "runtime_global_profile_id": "global.amazon.nova-2-lite-v1:0",
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-lite.html",
      "releaseSource": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-lite.html",
      "releaseNote": null
    },
    {
      "key": "zai-glm-5",
      "display_name": "GLM 5",
      "provider": "Z.AI",
      "provider_verified": true,
      "default_eligible": false,
      "eligibility_status": "excluded",
      "vendor_first_release_date": null,
      "bedrock_launch_date": "2026-02-11",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "text"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": true,
      "runtime_api_support_confirmed": [
        "Converse",
        "Invoke"
      ],
      "runtime_model_id": "zai.glm-5",
      "runtime_global_profile_id": null,
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-zai-glm-5.html",
      "releaseSource": null,
      "releaseNote": null
    },
    {
      "key": "openai-gpt-56-terra",
      "display_name": "GPT-5.6 Terra",
      "provider": "OpenAI",
      "provider_verified": true,
      "default_eligible": true,
      "eligibility_status": "eligible",
      "vendor_first_release_date": "2026-07-09",
      "bedrock_launch_date": "2026-07-13",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "image",
        "text"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": true,
      "runtime_api_support_confirmed": [
        "Responses",
        "Chat Completions",
        "Converse"
      ],
      "runtime_model_id": "openai.gpt-5.6-terra",
      "runtime_global_profile_id": "global.openai.gpt-5.6-terra",
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-terra.html",
      "releaseSource": "https://openai.com/index/gpt-5-6/",
      "releaseNote": null
    },
    {
      "key": "openai-gpt-56-luna",
      "display_name": "GPT-5.6 Luna",
      "provider": "OpenAI",
      "provider_verified": true,
      "default_eligible": true,
      "eligibility_status": "eligible",
      "vendor_first_release_date": "2026-07-09",
      "bedrock_launch_date": "2026-07-13",
      "first_runtime_support_date": null,
      "lifecycle": "active",
      "input_modalities": [
        "image",
        "text"
      ],
      "output_modalities": [
        "text"
      ],
      "runtime_supported": true,
      "runtime_api_support_confirmed": [
        "Responses",
        "Chat Completions",
        "Converse"
      ],
      "runtime_model_id": "openai.gpt-5.6-luna",
      "runtime_global_profile_id": "global.openai.gpt-5.6-luna",
      "aws_source_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-luna.html",
      "releaseSource": "https://openai.com/index/gpt-5-6/",
      "releaseNote": null
    }
  ]
};
