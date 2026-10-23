-- Akasha baseline schema v1.0
-- Generated from database state on 2026-10-21
-- All statements are idempotent (IF NOT EXISTS / OR REPLACE / DO exception blocks)

--
-- Name: pg_jieba; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_jieba WITH SCHEMA public;

--
-- Name: EXTENSION pg_jieba; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_jieba IS 'a parser for full-text search of Chinese';

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';

--
-- Name: unaccent; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;

--
-- Name: EXTENSION unaccent; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION unaccent IS 'text search dictionary that removes accents';

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';

--
-- Name: ai_chat_messages_tsvector_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.ai_chat_messages_tsvector_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      NEW.tsv := to_tsvector('english', f_unaccent(substring(coalesce(NEW.content, ''), 1, 100000)));
      RETURN NEW;
    END;
    $$;

--
-- Name: f_unaccent(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.f_unaccent(text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $_$
      SELECT unaccent('unaccent', $1);
    $_$;

--
-- Name: gen_uuid_v7(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.gen_uuid_v7() RETURNS uuid
    LANGUAGE plpgsql
    AS $$
        declare
              v_time numeric := null;
      
              v_unix_t numeric := null;
              v_rand_a numeric := null;
              v_rand_b numeric := null;
      
              v_unix_t_hex varchar := null;
              v_rand_a_hex varchar := null;
              v_rand_b_hex varchar := null;
      
              v_output_bytes bytea := null;
              
              c_milli_factor numeric := 10^3::numeric;  -- 1000
              c_micro_factor numeric := 10^6::numeric;  -- 1000000
              c_scale_factor numeric := 4.096::numeric; -- 4.0 * (1024 / 1000)
              
              c_version bit(64) := x'0000000000007000'; -- RFC-4122 version: b'0111...'
              c_variant bit(64) := x'8000000000000000'; -- RFC-4122 variant: b'10xx...'

        begin
              v_time := extract(epoch from clock_timestamp());
              
              v_unix_t := trunc(v_time * c_milli_factor);
              v_rand_a := ((v_time * c_micro_factor) - (v_unix_t * c_milli_factor)) * c_scale_factor;
              v_rand_b := random()::numeric * 2^62::numeric;
              
              v_unix_t_hex := lpad(to_hex(v_unix_t::bigint), 12, '0');
              v_rand_a_hex := lpad(to_hex((v_rand_a::bigint::bit(64) | c_version)::bigint), 4, '0');
              v_rand_b_hex := lpad(to_hex((v_rand_b::bigint::bit(64) | c_variant)::bigint), 16, '0');
              
              v_output_bytes := decode(v_unix_t_hex || v_rand_a_hex || v_rand_b_hex, 'hex');
    
              return encode(v_output_bytes, 'hex')::uuid;
              
              v_output_bytes := decode(v_unix_t_hex || v_rand_a_hex || v_rand_b_hex, 'hex');
    
              return encode(v_output_bytes, 'hex')::uuid;
     end $$;

--
-- Name: knowledge_chunks_search_tsv_zh_refresh(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.knowledge_chunks_search_tsv_zh_refresh() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      NEW.search_tsv_zh := to_tsvector('jiebaqry', coalesce(NEW.text, ''));
      RETURN NEW;
    END;
    $$;

--
-- Name: knowledge_zh_query_terms(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.knowledge_zh_query_terms(query text) RETURNS tsquery[]
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $_$
      SELECT coalesce(
               array_agg(
                 ('''' || replace(replace(lexeme, '\', '\\'), '''', '''''') || '''')::tsquery
                 ORDER BY lexeme
               ),
               '{}'
             )
      FROM unnest(tsvector_to_array(to_tsvector('jiebacfg', coalesce(query, '')))) AS lexeme
      WHERE lexeme !~ '^[[:space:][:punct:]\u00A0-\u00BF\u2000-\u206F\u3000-\u303F\uFE30-\uFE4F\uFF00-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]+$'
        AND lexeme <> ALL (ARRAY[
          '请问', '麻烦', '帮', '帮忙', '帮我', '我查', '一下', '告诉', '想', '想要',
          '了解', '介绍', '能不能', '不能', '可以', '能否', '是否', '应该', '需要',
          '怎么回事', '怎样才能', '干什么', '什么', '什么样', '哪些', '哪里', '哪个',
          '如何', '怎么', '怎么办', '怎样', '为什么', '为何', '是不是', '有没有',
          '具体', '意思', '指', '情况', '相关', '关于', '内容', '说明', '一些', '有关'
        ])
    $_$;

--
-- Name: knowledge_zh_tsquery(text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.knowledge_zh_tsquery(query text, match_all boolean DEFAULT false) RETURNS tsquery
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
      SELECT string_agg(
               term::text,
               CASE WHEN match_all THEN ' & ' ELSE ' | ' END
             )::tsquery
      FROM unnest(knowledge_zh_query_terms(query)) AS term
    $$;

--
-- Name: pages_tsvector_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.pages_tsvector_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
        new.tsv :=
                  setweight(to_tsvector('english', f_unaccent(coalesce(new.title, ''))), 'A') ||
                  setweight(to_tsvector('english', f_unaccent(substring(coalesce(new.text_content, ''), 1, 1000000))), 'B');
        return new;
    end;
    $$;

--
-- Name: templates_tsvector_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.templates_tsvector_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
        new.tsv :=
                  setweight(to_tsvector('english', f_unaccent(coalesce(new.title, ''))), 'A') ||
                  setweight(to_tsvector('english', f_unaccent(substring(coalesce(new.text_content, ''), 1, 1000000))), 'B');
        return new;
    end;
    $$;

--
-- Name: ai_chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.ai_chat_messages (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    chat_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid,
    role character varying NOT NULL,
    content text,
    tool_calls jsonb,
    metadata jsonb,
    tsv tsvector,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

--
-- Name: ai_chats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.ai_chats (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    creator_id uuid NOT NULL,
    title character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

--
-- Name: ai_model_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.ai_model_configs (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    feature character varying NOT NULL,
    provider character varying NOT NULL,
    model character varying NOT NULL,
    base_url character varying,
    api_key_encrypted text,
    parameters jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_model_configs_feature_check CHECK (((feature)::text = ANY (ARRAY[('compiler'::character varying)::text, ('answer'::character varying)::text, ('image'::character varying)::text, ('embedding'::character varying)::text]))),
    CONSTRAINT ai_model_configs_provider_check CHECK (((provider)::text = ANY (ARRAY[('openai'::character varying)::text, ('openai-compatible'::character varying)::text, ('gemini'::character varying)::text, ('ollama'::character varying)::text])))
);

--
-- Name: analytics_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.analytics_events (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid,
    event character varying(32) NOT NULL,
    route character varying(64),
    space_id uuid,
    page_id uuid,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: api_key_spaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.api_key_spaces (
    api_key_id uuid NOT NULL,
    space_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.api_keys (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    name text,
    creator_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    key_type character varying DEFAULT 'personal'::character varying NOT NULL,
    agent_user_id uuid,
    credential_version bigint,
    CONSTRAINT api_keys_agent_fields_check CHECK (((((key_type)::text = 'personal'::text) AND (agent_user_id IS NULL) AND (credential_version IS NULL)) OR (((key_type)::text = 'agent'::text) AND (agent_user_id IS NOT NULL) AND (credential_version IS NOT NULL) AND (expires_at IS NULL)))),
    CONSTRAINT api_keys_key_type_check CHECK (((key_type)::text = ANY (ARRAY[('personal'::character varying)::text, ('agent'::character varying)::text])))
);

--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.attachments (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    file_name character varying NOT NULL,
    file_path character varying NOT NULL,
    file_size bigint,
    file_ext character varying NOT NULL,
    mime_type character varying,
    type character varying,
    creator_id uuid NOT NULL,
    page_id uuid,
    space_id uuid,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    text_content text,
    tsv tsvector,
    ai_chat_id uuid
);

--
-- Name: audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.audit (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    actor_id uuid,
    actor_type character varying DEFAULT 'user'::character varying NOT NULL,
    event character varying NOT NULL,
    resource_type character varying NOT NULL,
    resource_id uuid,
    space_id uuid,
    changes jsonb,
    metadata jsonb,
    ip_address inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: auth_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.auth_accounts (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    user_id uuid NOT NULL,
    provider_user_id character varying NOT NULL,
    auth_provider_id uuid,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

--
-- Name: auth_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.auth_providers (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    name character varying NOT NULL,
    type text NOT NULL,
    saml_url character varying,
    saml_certificate character varying,
    oidc_issuer character varying,
    oidc_client_id character varying,
    oidc_client_secret character varying,
    allow_signup boolean DEFAULT false NOT NULL,
    is_enabled boolean DEFAULT false NOT NULL,
    creator_id uuid,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    group_sync boolean DEFAULT false NOT NULL,
    ldap_url character varying,
    ldap_bind_dn character varying,
    ldap_bind_password character varying,
    ldap_base_dn character varying,
    ldap_user_search_filter character varying,
    ldap_user_attributes jsonb DEFAULT '{}'::jsonb,
    ldap_tls_enabled boolean DEFAULT false,
    ldap_tls_ca_cert text,
    ldap_config jsonb DEFAULT '{}'::jsonb,
    settings jsonb DEFAULT '{}'::jsonb
);

--
-- Name: backlinks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.backlinks (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    source_page_id uuid NOT NULL,
    target_page_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: billing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.billing (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    stripe_subscription_id character varying NOT NULL,
    stripe_customer_id character varying,
    status character varying NOT NULL,
    quantity bigint,
    amount bigint,
    "interval" character varying,
    currency character varying,
    metadata jsonb,
    stripe_price_id character varying,
    stripe_item_id character varying,
    stripe_product_id character varying,
    period_start_at timestamp with time zone NOT NULL,
    period_end_at timestamp with time zone,
    cancel_at_period_end boolean,
    cancel_at timestamp with time zone,
    canceled_at timestamp with time zone,
    ended_at timestamp with time zone,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    billing_scheme character varying,
    tiered_up_to character varying,
    tiered_flat_amount bigint,
    tiered_unit_amount bigint,
    plan_name character varying
);

--
-- Name: comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.comments (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    content jsonb,
    selection character varying,
    type character varying,
    creator_id uuid,
    page_id uuid NOT NULL,
    parent_comment_id uuid,
    workspace_id uuid NOT NULL,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    edited_at timestamp with time zone,
    deleted_at timestamp with time zone,
    last_edited_by_id uuid,
    resolved_by_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    space_id uuid NOT NULL
);

--
-- Name: favorites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.favorites (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    user_id uuid NOT NULL,
    page_id uuid,
    space_id uuid,
    template_id uuid,
    type character varying NOT NULL,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: file_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.file_tasks (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    type character varying,
    source character varying,
    status character varying,
    file_name character varying NOT NULL,
    file_path character varying NOT NULL,
    file_size bigint,
    file_ext character varying,
    error_message character varying,
    creator_id uuid,
    space_id uuid,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    page_id uuid,
    metadata jsonb
);

--
-- Name: group_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.group_users (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    user_id uuid NOT NULL,
    group_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.groups (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    name character varying NOT NULL,
    description text,
    is_default boolean NOT NULL,
    workspace_id uuid NOT NULL,
    creator_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    scim_external_id text,
    is_external boolean DEFAULT false NOT NULL
);

--
-- Name: knowledge_artifact_contributions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_artifact_contributions (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    space_id uuid NOT NULL,
    source_page_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    artifact_kind character varying NOT NULL,
    canonical_key character varying NOT NULL,
    source_version character varying NOT NULL,
    source_content_hash character varying NOT NULL,
    compiler_version character varying NOT NULL,
    prompt_version character varying NOT NULL,
    compiler_run_id character varying NOT NULL,
    compile_task_id character varying NOT NULL,
    artifact jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: knowledge_chunk_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_chunk_attachments (
    workspace_id uuid NOT NULL,
    chunk_id uuid NOT NULL,
    occurrence_order integer NOT NULL,
    attachment_id uuid NOT NULL,
    source_page_id uuid NOT NULL,
    source_version text NOT NULL,
    source_content_hash text NOT NULL,
    attachment_updated_at timestamp with time zone NOT NULL
);

--
-- Name: knowledge_chunk_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_chunk_sources (
    chunk_id uuid NOT NULL,
    source_page_id uuid NOT NULL,
    source_version character varying NOT NULL,
    source_range jsonb,
    quote_hash character varying,
    content_hash character varying NOT NULL,
    provenance_kind character varying NOT NULL,
    workspace_id uuid NOT NULL
);

--
-- Name: knowledge_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_chunks (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    space_id uuid NOT NULL,
    knowledge_page_id uuid NOT NULL,
    text text NOT NULL,
    content_hash character varying NOT NULL,
    embedding_legacy jsonb,
    compiler_run_id character varying,
    compile_task_id character varying,
    stale_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    embedding public.vector,
    embedding_profile character varying(64),
    embedding_model character varying(255),
    embedding_dimensions integer,
    search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, COALESCE(text, ''::text))) STORED,
    parent_section_id uuid,
    stable_key character varying(64) NOT NULL,
    chunk_role character varying(32) DEFAULT 'child'::character varying NOT NULL,
    retrieval_channel character varying(32) DEFAULT 'memory'::character varying NOT NULL,
    heading_path jsonb DEFAULT '[]'::jsonb NOT NULL,
    start_offset integer,
    end_offset integer,
    search_tsv_zh tsvector,
    embedding_total_tokens integer,
    embedding_duration_ms integer,
    CONSTRAINT knowledge_chunks_embedding_metadata_check CHECK ((((embedding IS NULL) AND (embedding_profile IS NULL) AND (embedding_model IS NULL) AND (embedding_dimensions IS NULL)) OR ((embedding IS NOT NULL) AND (embedding_profile IS NOT NULL) AND (embedding_model IS NOT NULL) AND (embedding_dimensions > 0) AND (public.vector_dims(embedding) = embedding_dimensions)))),
    CONSTRAINT knowledge_chunks_embedding_usage_check CHECK ((((embedding_total_tokens IS NULL) OR (embedding_total_tokens >= 0)) AND ((embedding_duration_ms IS NULL) OR (embedding_duration_ms >= 0)))),
    CONSTRAINT knowledge_chunks_range_check CHECK ((((start_offset IS NULL) AND (end_offset IS NULL)) OR ((start_offset >= 0) AND (end_offset > start_offset)))),
    CONSTRAINT knowledge_chunks_retrieval_channel_check CHECK (((retrieval_channel)::text = ANY (ARRAY[('evidence'::character varying)::text, ('memory'::character varying)::text]))),
    CONSTRAINT knowledge_chunks_role_check CHECK (((chunk_role)::text = ANY (ARRAY[('child'::character varying)::text, ('standalone'::character varying)::text])))
);

--
-- Name: knowledge_compilation_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_compilation_attempts (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    space_id uuid NOT NULL,
    source_page_id uuid NOT NULL,
    source_version character varying,
    source_content_hash character varying,
    status character varying DEFAULT 'queued'::character varying NOT NULL,
    stage character varying DEFAULT 'queued'::character varying NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    compiler_version character varying NOT NULL,
    prompt_version character varying NOT NULL,
    compiler_run_id character varying,
    compile_task_id character varying,
    error_code character varying,
    error_message character varying,
    last_successful_source_version character varying,
    last_successful_source_hash character varying,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    last_succeeded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    effective_knowledge_hash character varying,
    last_successful_effective_hash character varying,
    compiler_model character varying,
    compiler_profile character varying,
    analysis_candidate_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    analysis_candidate_hash character varying,
    generation_candidate_ids jsonb DEFAULT '[]'::jsonb CONSTRAINT knowledge_compilation_attempt_generation_candidate_ids_not_null NOT NULL,
    generation_candidate_hash character varying
);

--
-- Name: knowledge_embedding_rebuild_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_embedding_rebuild_batches (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    space_id uuid NOT NULL,
    chunk_count integer NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    total_tokens integer,
    duration_ms integer NOT NULL,
    embedding_profile character varying(64),
    embedding_model character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_embedding_rebuild_batches_counts_check CHECK (((chunk_count >= 0) AND (failed_count >= 0) AND (duration_ms >= 0) AND ((total_tokens IS NULL) OR (total_tokens >= 0))))
);

--
-- Name: knowledge_graph_edge_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_graph_edge_sources (
    graph_edge_id uuid NOT NULL,
    source_page_id uuid NOT NULL,
    source_version character varying NOT NULL,
    source_range jsonb,
    quote_hash character varying,
    content_hash character varying NOT NULL,
    provenance_kind character varying NOT NULL,
    workspace_id uuid NOT NULL
);

--
-- Name: knowledge_graph_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_graph_edges (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    space_id uuid NOT NULL,
    from_knowledge_page_id uuid NOT NULL,
    to_knowledge_page_id uuid,
    relation text NOT NULL,
    compiler_run_id character varying,
    compile_task_id character varying,
    stale_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    relation_type character varying,
    target_artifact_kind character varying,
    target_canonical_key character varying,
    is_dangling boolean DEFAULT false NOT NULL
);

--
-- Name: knowledge_image_extractions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_image_extractions (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    attachment_id uuid NOT NULL,
    content_hash character varying NOT NULL,
    model character varying NOT NULL,
    prompt_version character varying NOT NULL,
    status character varying NOT NULL,
    mime_type character varying,
    file_name character varying,
    ocr_text text,
    caption text,
    error_code character varying,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cache_fingerprint character varying NOT NULL,
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    retryable boolean,
    retry_after timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    attachment_version timestamp with time zone,
    CONSTRAINT knowledge_image_extractions_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT knowledge_image_extractions_lifecycle_check CHECK (((((status)::text = 'processing'::text) AND (lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (retryable IS NULL) AND (retry_after IS NULL)) OR (((status)::text = 'ready'::text) AND (lease_token IS NULL) AND (lease_expires_at IS NULL) AND (retryable IS NULL) AND (retry_after IS NULL)) OR (((status)::text = 'failed'::text) AND (lease_token IS NULL) AND (lease_expires_at IS NULL) AND (retryable IS NOT NULL) AND (error_code IS NOT NULL) AND (((retryable = true) AND (retry_after IS NOT NULL)) OR ((retryable = false) AND (retry_after IS NULL)))))),
    CONSTRAINT knowledge_image_extractions_status_check CHECK (((status)::text = ANY (ARRAY[('processing'::character varying)::text, ('ready'::character varying)::text, ('failed'::character varying)::text])))
);

--
-- Name: knowledge_link_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_link_sources (
    link_id uuid NOT NULL,
    source_page_id uuid NOT NULL,
    source_version character varying NOT NULL,
    source_range jsonb,
    quote_hash character varying,
    content_hash character varying NOT NULL,
    provenance_kind character varying NOT NULL,
    workspace_id uuid NOT NULL
);

--
-- Name: knowledge_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_links (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    space_id uuid NOT NULL,
    from_knowledge_page_id uuid NOT NULL,
    to_knowledge_page_id uuid,
    target_page_id uuid,
    target_space_id uuid,
    link_text text NOT NULL,
    link_type character varying NOT NULL,
    is_dangling boolean DEFAULT false NOT NULL,
    compiler_run_id character varying,
    compile_task_id character varying,
    stale_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    target_artifact_kind character varying,
    target_canonical_key character varying
);

--
-- Name: knowledge_page_compile_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_page_compile_schedules (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    space_id uuid NOT NULL,
    source_page_id uuid NOT NULL,
    trigger character varying NOT NULL,
    change_count integer DEFAULT 1 NOT NULL,
    first_changed_at timestamp with time zone NOT NULL,
    last_changed_at timestamp with time zone NOT NULL,
    eligible_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_knowledge_page_compile_schedules_change_count CHECK ((change_count >= 1)),
    CONSTRAINT chk_knowledge_page_compile_schedules_time_order CHECK (((first_changed_at <= last_changed_at) AND (last_changed_at <= eligible_at))),
    CONSTRAINT chk_knowledge_page_compile_schedules_trigger CHECK (((trigger)::text = ANY (ARRAY[('page_created'::character varying)::text, ('page_updated'::character varying)::text])))
);

--
-- Name: knowledge_page_index_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_page_index_settings (
    workspace_id uuid NOT NULL,
    source_page_id uuid NOT NULL,
    index_mode character varying(32) DEFAULT 'compiled'::character varying NOT NULL,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_page_index_settings_mode_check CHECK (((index_mode)::text = ANY ((ARRAY['compiled'::character varying, 'original'::character varying])::text[])))
);

--
-- Name: knowledge_page_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_page_sources (
    knowledge_page_id uuid NOT NULL,
    source_page_id uuid NOT NULL,
    source_version character varying NOT NULL,
    source_range jsonb,
    quote_hash character varying,
    content_hash character varying NOT NULL,
    provenance_kind character varying NOT NULL,
    workspace_id uuid NOT NULL
);

--
-- Name: knowledge_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_pages (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    space_id uuid NOT NULL,
    compile_scope character varying NOT NULL,
    title character varying NOT NULL,
    slug character varying NOT NULL,
    page_type character varying,
    body text NOT NULL,
    compiled_at timestamp with time zone NOT NULL,
    compiler_version character varying NOT NULL,
    compiler_run_id character varying,
    compile_task_id character varying,
    stale_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    generation_mode character varying DEFAULT 'legacy'::character varying NOT NULL,
    canonical_key character varying,
    CONSTRAINT chk_knowledge_pages_active_page_publication CHECK (((stale_at IS NOT NULL) OR (((compile_scope)::text = 'page'::text) AND ((page_type)::text IS DISTINCT FROM 'overview'::text))))
);

--
-- Name: knowledge_parent_section_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_parent_section_sources (
    workspace_id uuid NOT NULL,
    parent_section_id uuid NOT NULL,
    source_page_id uuid NOT NULL,
    source_version character varying NOT NULL,
    source_range jsonb,
    quote_hash character varying,
    content_hash character varying NOT NULL,
    provenance_kind character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: knowledge_parent_sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_parent_sections (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    space_id uuid NOT NULL,
    knowledge_page_id uuid NOT NULL,
    stable_key character varying(64) NOT NULL,
    heading_path jsonb DEFAULT '[]'::jsonb NOT NULL,
    text text NOT NULL,
    content_hash character varying(72) NOT NULL,
    start_offset integer,
    end_offset integer,
    stale_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_parent_sections_range_check CHECK ((((start_offset IS NULL) AND (end_offset IS NULL)) OR ((start_offset >= 0) AND (end_offset > start_offset))))
);

--
-- Name: knowledge_quarantined_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_quarantined_artifacts (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    space_id uuid NOT NULL,
    artifact_id character varying,
    artifact_kind character varying,
    compiler_run_id character varying,
    compile_task_id character varying,
    reason_codes jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: knowledge_query_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_query_audit (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid,
    query_hash character varying NOT NULL,
    retrieval_mode character varying NOT NULL,
    authorized_capsule_count integer NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: knowledge_review_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_review_applications (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    space_id uuid NOT NULL,
    review_item_id character varying NOT NULL,
    status character varying DEFAULT 'draft'::character varying NOT NULL,
    operation character varying NOT NULL,
    target_page_id uuid,
    target_page_title text,
    target_heading_path jsonb DEFAULT '[]'::jsonb NOT NULL,
    base_page_version character varying,
    base_content_hash character varying,
    before_content text,
    after_content text NOT NULL,
    after_content_hash character varying NOT NULL,
    patch jsonb,
    created_page_id uuid,
    applied_at timestamp with time zone,
    reverted_at timestamp with time zone,
    applied_by uuid NOT NULL,
    rationale text DEFAULT ''::text NOT NULL,
    source_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: knowledge_review_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_review_snapshots (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    space_id uuid NOT NULL,
    version character varying DEFAULT '2'::character varying NOT NULL,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    docs jsonb DEFAULT '[]'::jsonb NOT NULL,
    resolved_reviews jsonb DEFAULT '[]'::jsonb NOT NULL,
    discovered_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    jobs jsonb DEFAULT '[]'::jsonb NOT NULL
);

--
-- Name: knowledge_source_access_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_source_access_policy (
    workspace_id uuid NOT NULL,
    source_page_id uuid NOT NULL,
    source_space_id uuid NOT NULL,
    policy_hash character varying NOT NULL,
    policy_version integer DEFAULT 1 NOT NULL,
    restricted_ancestor_count integer DEFAULT 0 CONSTRAINT knowledge_source_access_poli_restricted_ancestor_count_not_null NOT NULL,
    stale_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: knowledge_source_access_principals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_source_access_principals (
    workspace_id uuid NOT NULL,
    source_page_id uuid NOT NULL,
    requirement_id uuid NOT NULL,
    principal_type character varying NOT NULL,
    principal_id uuid NOT NULL,
    role character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: knowledge_source_access_requirements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_source_access_requirements (
    workspace_id uuid NOT NULL,
    source_page_id uuid NOT NULL,
    requirement_id uuid NOT NULL,
    restricted_page_id uuid CONSTRAINT knowledge_source_access_requirement_restricted_page_id_not_null NOT NULL,
    depth integer NOT NULL
);

--
-- Name: knowledge_source_analyses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_source_analyses (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    space_id uuid NOT NULL,
    source_page_id uuid NOT NULL,
    source_version character varying NOT NULL,
    source_content_hash character varying NOT NULL,
    compiler_version character varying NOT NULL,
    prompt_version character varying NOT NULL,
    analysis jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: knowledge_source_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_source_chunks (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    source_id uuid NOT NULL,
    source_page_id uuid NOT NULL,
    text text NOT NULL,
    content_hash character varying NOT NULL,
    source_range jsonb,
    quote_hash character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: knowledge_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_sources (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    source_type character varying NOT NULL,
    source_page_id uuid NOT NULL,
    source_space_id uuid NOT NULL,
    attachment_id uuid,
    source_version character varying NOT NULL,
    content_hash character varying NOT NULL,
    mime_type character varying,
    extracted_text text,
    stale_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

--
-- Name: knowledge_space_compile_run_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_space_compile_run_images (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    run_id uuid NOT NULL,
    run_page_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    space_id uuid NOT NULL,
    source_page_id uuid NOT NULL,
    attachment_id uuid NOT NULL,
    image_ordinal integer NOT NULL,
    file_name character varying NOT NULL,
    mime_type character varying NOT NULL,
    file_size bigint,
    alt_text text,
    expected_attachment_version timestamp with time zone CONSTRAINT knowledge_space_compile_run_expected_attachment_versio_not_null NOT NULL,
    status character varying DEFAULT 'pending'::character varying NOT NULL,
    job_id character varying,
    dispatched_at timestamp with time zone,
    processing_expires_at timestamp with time zone,
    extraction_id uuid,
    attempt_count integer DEFAULT 0 NOT NULL,
    redis_recovery_count integer DEFAULT 0 CONSTRAINT knowledge_space_compile_run_image_redis_recovery_count_not_null NOT NULL,
    failure_class character varying,
    error_code character varying,
    error_message character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_knowledge_space_compile_run_images_attempt_count CHECK ((attempt_count >= 0)),
    CONSTRAINT chk_knowledge_space_compile_run_images_failure_class CHECK (((failure_class IS NULL) OR ((failure_class)::text = ANY (ARRAY[('retryable_exhausted'::character varying)::text, ('permanent'::character varying)::text])))),
    CONSTRAINT chk_knowledge_space_compile_run_images_failure_lifecycle CHECK (((((status)::text = 'failed'::text) OR (failure_class IS NULL)) AND (((status)::text <> 'failed'::text) OR (failure_class IS NOT NULL)))),
    CONSTRAINT chk_knowledge_space_compile_run_images_file_size CHECK (((file_size IS NULL) OR (file_size >= 0))),
    CONSTRAINT chk_knowledge_space_compile_run_images_mime_type CHECK (((mime_type)::text = ANY (ARRAY[('image/jpeg'::character varying)::text, ('image/png'::character varying)::text, ('image/apng'::character varying)::text, ('image/gif'::character varying)::text, ('image/webp'::character varying)::text, ('image/avif'::character varying)::text, ('image/tiff'::character varying)::text, ('image/bmp'::character varying)::text]))),
    CONSTRAINT chk_knowledge_space_compile_run_images_ordinal CHECK (((image_ordinal >= 0) AND (image_ordinal <= 49))),
    CONSTRAINT chk_knowledge_space_compile_run_images_recovery_count CHECK (((redis_recovery_count >= 0) AND (redis_recovery_count <= 3))),
    CONSTRAINT chk_knowledge_space_compile_run_images_status CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('queued'::character varying)::text, ('processing'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('skipped'::character varying)::text])))
);

--
-- Name: knowledge_space_compile_run_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_space_compile_run_pages (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    run_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    space_id uuid NOT NULL,
    source_page_id uuid NOT NULL,
    expected_source_version character varying,
    expected_source_content_hash character varying,
    job_id character varying,
    status character varying DEFAULT 'pending'::character varying NOT NULL,
    error_code character varying,
    error_message character varying,
    queued_at timestamp with time zone,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expected_image_count integer DEFAULT 0,
    succeeded_image_count integer DEFAULT 0 CONSTRAINT knowledge_space_compile_run_page_succeeded_image_count_not_null NOT NULL,
    failed_image_count integer DEFAULT 0 NOT NULL,
    image_status character varying DEFAULT 'not_required'::character varying NOT NULL,
    merge_status character varying DEFAULT 'not_required'::character varying NOT NULL,
    merge_job_id character varying,
    target_effective_knowledge_hash character varying,
    merged_effective_knowledge_hash character varying,
    skipped_image_count integer DEFAULT 0 NOT NULL,
    binding_status character varying DEFAULT 'bound'::character varying NOT NULL,
    discovered_source_version timestamp with time zone,
    bound_at timestamp with time zone DEFAULT now(),
    quality_status character varying DEFAULT 'normal'::character varying NOT NULL,
    reused boolean DEFAULT false NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    merge_attempt_count integer DEFAULT 0 NOT NULL,
    merge_dispatched_at timestamp with time zone,
    merge_processing_expires_at timestamp with time zone,
    merge_redis_recovery_count integer DEFAULT 0 CONSTRAINT knowledge_space_compile_run_merge_redis_recovery_count_not_null NOT NULL,
    merge_failure_class character varying,
    merge_execution_token character varying,
    merge_worker_id character varying,
    merge_heartbeat_at timestamp with time zone,
    index_mode character varying(32) DEFAULT 'compiled'::character varying NOT NULL,
    CONSTRAINT chk_knowledge_run_pages_merge_failure_class CHECK (((merge_failure_class IS NULL) OR ((merge_failure_class)::text = ANY (ARRAY[('retryable_exhausted'::character varying)::text, ('permanent'::character varying)::text])))),
    CONSTRAINT chk_knowledge_run_pages_merge_redis_recovery_count CHECK (((merge_redis_recovery_count >= 0) AND (merge_redis_recovery_count <= 3))),
    CONSTRAINT chk_knowledge_space_compile_run_pages_attempt_count CHECK (((attempt_count >= 0) AND (merge_attempt_count >= 0))),
    CONSTRAINT chk_knowledge_space_compile_run_pages_binding CHECK (((((binding_status)::text = ANY (ARRAY[('unbound'::character varying)::text, ('binding'::character varying)::text])) AND (expected_source_version IS NULL) AND (expected_source_content_hash IS NULL) AND (expected_image_count IS NULL) AND (bound_at IS NULL)) OR (((binding_status)::text = 'bound'::text) AND (expected_source_version IS NOT NULL) AND (expected_source_content_hash IS NOT NULL) AND (expected_image_count IS NOT NULL) AND (bound_at IS NOT NULL)))),
    CONSTRAINT chk_knowledge_space_compile_run_pages_binding_status CHECK (((binding_status)::text = ANY (ARRAY[('unbound'::character varying)::text, ('binding'::character varying)::text, ('bound'::character varying)::text]))),
    CONSTRAINT chk_knowledge_space_compile_run_pages_image_counts CHECK (((expected_image_count >= 0) AND (succeeded_image_count >= 0) AND (failed_image_count >= 0) AND (skipped_image_count >= 0) AND (((succeeded_image_count + failed_image_count) + skipped_image_count) <= expected_image_count))),
    CONSTRAINT chk_knowledge_space_compile_run_pages_image_status CHECK (((image_status)::text = ANY (ARRAY[('not_required'::character varying)::text, ('pending'::character varying)::text, ('queued'::character varying)::text, ('processing'::character varying)::text, ('succeeded'::character varying)::text, ('partial'::character varying)::text, ('failed'::character varying)::text]))),
    CONSTRAINT chk_knowledge_space_compile_run_pages_merge_status CHECK (((merge_status)::text = ANY (ARRAY[('not_required'::character varying)::text, ('waiting_images'::character varying)::text, ('pending'::character varying)::text, ('queued'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('skipped'::character varying)::text, ('failed'::character varying)::text]))),
    CONSTRAINT chk_knowledge_space_compile_run_pages_quality_status CHECK (((quality_status)::text = ANY (ARRAY[('normal'::character varying)::text, ('degraded'::character varying)::text, ('partial_image'::character varying)::text]))),
    CONSTRAINT chk_knowledge_space_compile_run_pages_status CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('queued'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('skipped'::character varying)::text]))),
    CONSTRAINT knowledge_space_compile_run_pages_index_mode_check CHECK (((index_mode)::text = ANY ((ARRAY['compiled'::character varying, 'original'::character varying])::text[])))
);

--
-- Name: knowledge_space_compile_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.knowledge_space_compile_runs (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    space_id uuid NOT NULL,
    trigger character varying NOT NULL,
    status character varying DEFAULT 'queued'::character varying NOT NULL,
    expected_page_count integer DEFAULT 0 NOT NULL,
    succeeded_page_count integer DEFAULT 0 NOT NULL,
    failed_page_count integer DEFAULT 0 NOT NULL,
    skipped_page_count integer DEFAULT 0 NOT NULL,
    compiler_version character varying NOT NULL,
    prompt_version character varying NOT NULL,
    aggregate_job_id character varying,
    imported_artifact_count integer DEFAULT 0 NOT NULL,
    quarantined_artifact_count integer DEFAULT 0 CONSTRAINT knowledge_space_compile_run_quarantined_artifact_count_not_null NOT NULL,
    error_code character varying,
    error_message character varying,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    aggregate_started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    mode character varying DEFAULT 'incremental'::character varying NOT NULL,
    knowledge_generation integer DEFAULT 0 NOT NULL,
    phase character varying DEFAULT 'text'::character varying NOT NULL,
    initialized_at timestamp with time zone,
    space_job_id character varying,
    space_job_dispatched_at timestamp with time zone,
    space_job_sequence integer DEFAULT 0 NOT NULL,
    space_job_queued_at timestamp with time zone,
    space_job_recovery_count integer DEFAULT 0 NOT NULL,
    execution_token character varying,
    execution_lease_expires_at timestamp with time zone,
    worker_id character varying,
    heartbeat_at timestamp with time zone,
    last_yield_at timestamp with time zone,
    last_yield_reason character varying,
    rerun_requested boolean DEFAULT false NOT NULL,
    target_source_page_ids jsonb,
    follow_up_target_source_page_ids jsonb,
    CONSTRAINT chk_knowledge_space_compile_runs_counts CHECK (((expected_page_count >= 0) AND (succeeded_page_count >= 0) AND (failed_page_count >= 0) AND (skipped_page_count >= 0) AND (((succeeded_page_count + failed_page_count) + skipped_page_count) <= expected_page_count))),
    CONSTRAINT chk_knowledge_space_compile_runs_knowledge_generation CHECK ((knowledge_generation >= 0)),
    CONSTRAINT chk_knowledge_space_compile_runs_last_yield_reason CHECK (((last_yield_reason IS NULL) OR ((last_yield_reason)::text = ANY (ARRAY[('page_limit'::character varying)::text, ('time_limit'::character varying)::text])))),
    CONSTRAINT chk_knowledge_space_compile_runs_mode CHECK (((mode)::text = ANY (ARRAY[('incremental'::character varying)::text, ('force_rebuild'::character varying)::text]))),
    CONSTRAINT chk_knowledge_space_compile_runs_phase CHECK (((phase)::text = ANY (ARRAY[('text'::character varying)::text, ('images'::character varying)::text, ('image_merge'::character varying)::text, ('finalizing'::character varying)::text, ('complete'::character varying)::text]))),
    CONSTRAINT chk_knowledge_space_compile_runs_space_job_recovery_count CHECK (((space_job_recovery_count >= 0) AND (space_job_recovery_count <= 3))),
    CONSTRAINT chk_knowledge_space_compile_runs_space_job_sequence CHECK ((space_job_sequence >= 0)),
    CONSTRAINT chk_knowledge_space_compile_runs_status CHECK (((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('compiling'::character varying)::text, ('aggregating'::character varying)::text, ('succeeded'::character varying)::text, ('partial'::character varying)::text, ('failed'::character varying)::text, ('superseded'::character varying)::text, ('cancelled'::character varying)::text])))
);

--
-- Name: labels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.labels (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    name character varying NOT NULL,
    type character varying DEFAULT 'page'::character varying NOT NULL,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: legacy_link_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.legacy_link_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source character varying NOT NULL,
    legacy_host character varying,
    legacy_space_id character varying,
    legacy_space_key character varying,
    legacy_page_id character varying,
    legacy_title character varying,
    legacy_path character varying,
    legacy_anchor character varying,
    target_space_id uuid,
    target_page_id uuid,
    target_attachment_id uuid,
    target_url character varying,
    import_task_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.notifications (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    type text NOT NULL,
    actor_id uuid,
    page_id uuid,
    space_id uuid,
    comment_id uuid,
    data jsonb,
    read_at timestamp with time zone,
    emailed_at timestamp with time zone,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    page_verification_id uuid
);

--
-- Name: page_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.page_access (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    page_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    space_id uuid NOT NULL,
    access_level character varying NOT NULL,
    creator_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: page_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.page_history (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    page_id uuid NOT NULL,
    slug_id character varying,
    title character varying,
    content jsonb,
    slug character varying,
    icon character varying,
    cover_photo character varying,
    version integer,
    last_updated_by_id uuid,
    space_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    contributor_ids uuid[] DEFAULT '{}'::uuid[],
    previous_history_id uuid,
    diff_algorithm_version character varying,
    diff_schema_version character varying,
    diff_from_content_hash character varying,
    diff_to_content_hash character varying,
    diff_status character varying,
    diff_changes jsonb,
    diff_added_count integer DEFAULT 0 NOT NULL,
    diff_deleted_count integer DEFAULT 0 NOT NULL,
    diff_error_code character varying
);

--
-- Name: page_labels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.page_labels (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    page_id uuid NOT NULL,
    label_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: page_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.page_permissions (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    page_access_id uuid NOT NULL,
    user_id uuid,
    group_id uuid,
    role character varying NOT NULL,
    added_by_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT allow_either_user_id_or_group_id_check CHECK ((((user_id IS NOT NULL) AND (group_id IS NULL)) OR ((user_id IS NULL) AND (group_id IS NOT NULL))))
);

--
-- Name: page_transclusion_references; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.page_transclusion_references (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    reference_page_id uuid NOT NULL,
    source_page_id uuid NOT NULL,
    transclusion_id character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: page_transclusions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.page_transclusions (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    page_id uuid NOT NULL,
    transclusion_id character varying NOT NULL,
    content jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: page_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.page_verifications (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    page_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    space_id uuid NOT NULL,
    type character varying DEFAULT 'expiring'::character varying NOT NULL,
    status character varying,
    mode character varying,
    period_amount integer,
    period_unit character varying,
    verified_at timestamp with time zone,
    verified_by_id uuid,
    expires_at timestamp with time zone,
    requested_at timestamp with time zone,
    requested_by_id uuid,
    rejected_at timestamp with time zone,
    rejected_by_id uuid,
    rejection_comment text,
    data jsonb,
    creator_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: page_verifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.page_verifiers (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    page_verification_id uuid NOT NULL,
    user_id uuid NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    added_by_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: page_visits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.page_visits (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    page_id uuid NOT NULL,
    last_visited_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.pages (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    slug_id character varying NOT NULL,
    title character varying,
    icon character varying,
    cover_photo character varying,
    "position" character varying,
    content jsonb,
    ydoc bytea,
    text_content text,
    tsv tsvector,
    parent_page_id uuid,
    creator_id uuid,
    last_updated_by_id uuid,
    deleted_by_id uuid,
    space_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    is_locked boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    contributor_ids uuid[] DEFAULT '{}'::uuid[],
    source_creator_name character varying,
    source_last_updated_by_name character varying
);

--
-- Name: scim_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.scim_tokens (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    name character varying NOT NULL,
    token_hash character varying NOT NULL,
    token_last_four character varying(4) NOT NULL,
    last_used_at timestamp with time zone,
    is_enabled boolean DEFAULT true NOT NULL,
    creator_id uuid,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

--
-- Name: shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.shares (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    key character varying NOT NULL,
    page_id uuid,
    include_sub_pages boolean DEFAULT false,
    search_indexing boolean DEFAULT false,
    creator_id uuid,
    space_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

--
-- Name: space_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.space_members (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    user_id uuid,
    group_id uuid,
    space_id uuid NOT NULL,
    role character varying NOT NULL,
    added_by_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT allow_either_user_id_or_group_id_check CHECK ((((user_id IS NOT NULL) AND (group_id IS NULL)) OR ((user_id IS NULL) AND (group_id IS NOT NULL))))
);

--
-- Name: spaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.spaces (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    name character varying,
    description text,
    slug character varying NOT NULL,
    logo character varying,
    visibility character varying DEFAULT 'private'::character varying NOT NULL,
    default_role character varying DEFAULT 'writer'::character varying NOT NULL,
    creator_id uuid,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    settings jsonb,
    personal_owner_id uuid,
    knowledge_generation integer DEFAULT 0 NOT NULL,
    CONSTRAINT chk_spaces_knowledge_generation CHECK ((knowledge_generation >= 0))
);

--
-- Name: templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.templates (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    title character varying,
    description text,
    content jsonb,
    ydoc bytea,
    icon character varying,
    space_id uuid,
    workspace_id uuid NOT NULL,
    creator_id uuid,
    last_updated_by_id uuid,
    collaborator_ids uuid[],
    text_content text,
    tsv tsvector,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

--
-- Name: user_mfa; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.user_mfa (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    user_id uuid NOT NULL,
    method character varying DEFAULT 'totp'::character varying NOT NULL,
    secret text,
    is_enabled boolean DEFAULT false,
    backup_codes text[],
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.user_sessions (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    device_name character varying,
    user_agent text,
    ip_address inet,
    geo_location character varying,
    last_active_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    metadata jsonb,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: user_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.user_tokens (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    token character varying NOT NULL,
    type character varying NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid,
    expires_at timestamp with time zone,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.users (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    name character varying,
    email character varying NOT NULL,
    email_verified_at timestamp with time zone,
    password character varying,
    avatar_url character varying,
    role character varying,
    invited_by_id uuid,
    workspace_id uuid,
    locale character varying,
    timezone character varying,
    settings jsonb,
    last_active_at timestamp with time zone,
    last_login_at timestamp with time zone,
    deactivated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    has_generated_password boolean DEFAULT false NOT NULL,
    scim_external_id text,
    user_type character varying DEFAULT 'normal'::character varying NOT NULL,
    CONSTRAINT users_user_type_check CHECK (((user_type)::text = ANY (ARRAY[('normal'::character varying)::text, ('agent'::character varying)::text])))
);

--
-- Name: watchers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.watchers (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    user_id uuid NOT NULL,
    page_id uuid,
    space_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    type text NOT NULL,
    added_by_id uuid,
    muted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: workspace_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.workspace_invitations (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    email character varying,
    role character varying NOT NULL,
    token character varying NOT NULL,
    group_ids uuid[],
    invited_by_id uuid,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.workspaces (
    id uuid DEFAULT public.gen_uuid_v7() NOT NULL,
    name character varying,
    description character varying,
    logo character varying,
    hostname character varying,
    custom_domain character varying,
    settings jsonb,
    default_role character varying DEFAULT 'member'::character varying NOT NULL,
    email_domains character varying[] DEFAULT '{}'::character varying[],
    default_space_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    stripe_customer_id character varying,
    status character varying,
    plan character varying,
    billing_email character varying,
    trial_end_at timestamp with time zone,
    enforce_sso boolean DEFAULT false NOT NULL,
    license_key character varying,
    enforce_mfa boolean DEFAULT false,
    audit_retention_days bigint,
    trash_retention_days bigint,
    is_scim_enabled boolean DEFAULT false NOT NULL
);

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.ai_chat_messages
      ADD CONSTRAINT ai_chat_messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.ai_chats
      ADD CONSTRAINT ai_chats_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.ai_model_configs
      ADD CONSTRAINT ai_model_configs_feature_key UNIQUE (feature);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.ai_model_configs
      ADD CONSTRAINT ai_model_configs_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.analytics_events
      ADD CONSTRAINT analytics_events_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.api_key_spaces
      ADD CONSTRAINT api_key_spaces_pkey PRIMARY KEY (api_key_id, space_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.api_keys
      ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.attachments
      ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.audit
      ADD CONSTRAINT audit_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.auth_accounts
      ADD CONSTRAINT auth_accounts_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.auth_accounts
      ADD CONSTRAINT auth_accounts_user_id_auth_provider_id_unique UNIQUE (user_id, auth_provider_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.auth_providers
      ADD CONSTRAINT auth_providers_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.backlinks
      ADD CONSTRAINT backlinks_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.backlinks
      ADD CONSTRAINT backlinks_source_page_id_target_page_id_unique UNIQUE (source_page_id, target_page_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.billing
      ADD CONSTRAINT billing_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.billing
      ADD CONSTRAINT billing_stripe_subscription_id_unique UNIQUE (stripe_subscription_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.comments
      ADD CONSTRAINT comments_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.favorites
      ADD CONSTRAINT favorites_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.file_tasks
      ADD CONSTRAINT file_tasks_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.group_users
      ADD CONSTRAINT group_users_group_id_user_id_unique UNIQUE (group_id, user_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.group_users
      ADD CONSTRAINT group_users_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.groups
      ADD CONSTRAINT groups_name_workspace_id_unique UNIQUE (name, workspace_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.groups
      ADD CONSTRAINT groups_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.workspace_invitations
      ADD CONSTRAINT invitations_email_workspace_id_unique UNIQUE (email, workspace_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_artifact_contributions
      ADD CONSTRAINT knowledge_artifact_contributions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_chunk_attachments
      ADD CONSTRAINT knowledge_chunk_attachments_pkey PRIMARY KEY (chunk_id, occurrence_order);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_chunks
      ADD CONSTRAINT knowledge_chunks_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_chunks
      ADD CONSTRAINT knowledge_chunks_stable_key_unique UNIQUE (workspace_id, knowledge_page_id, stable_key);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_compilation_attempts
      ADD CONSTRAINT knowledge_compilation_attempts_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_embedding_rebuild_batches
      ADD CONSTRAINT knowledge_embedding_rebuild_batches_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_graph_edges
      ADD CONSTRAINT knowledge_graph_edges_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_image_extractions
      ADD CONSTRAINT knowledge_image_extractions_cache_fingerprint_unique UNIQUE (workspace_id, attachment_id, cache_fingerprint);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_image_extractions
      ADD CONSTRAINT knowledge_image_extractions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_links
      ADD CONSTRAINT knowledge_links_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_page_compile_schedules
      ADD CONSTRAINT knowledge_page_compile_schedules_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_page_index_settings
      ADD CONSTRAINT knowledge_page_index_settings_pk PRIMARY KEY (workspace_id, source_page_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_pages
      ADD CONSTRAINT knowledge_pages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_parent_section_sources
      ADD CONSTRAINT knowledge_parent_section_sources_pkey PRIMARY KEY (parent_section_id, source_page_id, source_version);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_parent_sections
      ADD CONSTRAINT knowledge_parent_sections_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_parent_sections
      ADD CONSTRAINT knowledge_parent_sections_workspace_id_knowledge_page_id_st_key UNIQUE (workspace_id, knowledge_page_id, stable_key);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_quarantined_artifacts
      ADD CONSTRAINT knowledge_quarantined_artifacts_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_query_audit
      ADD CONSTRAINT knowledge_query_audit_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_review_applications
      ADD CONSTRAINT knowledge_review_applications_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_review_snapshots
      ADD CONSTRAINT knowledge_review_snapshots_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_review_snapshots
      ADD CONSTRAINT knowledge_review_snapshots_workspace_space_unique UNIQUE (workspace_id, space_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_source_access_policy
      ADD CONSTRAINT knowledge_source_access_policy_pk PRIMARY KEY (workspace_id, source_page_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_source_access_requirements
      ADD CONSTRAINT knowledge_source_access_requirements_pk PRIMARY KEY (workspace_id, source_page_id, requirement_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_source_analyses
      ADD CONSTRAINT knowledge_source_analyses_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_source_chunks
      ADD CONSTRAINT knowledge_source_chunks_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_sources
      ADD CONSTRAINT knowledge_sources_page_version_unique UNIQUE (workspace_id, source_page_id, source_version);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_sources
      ADD CONSTRAINT knowledge_sources_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_space_compile_run_images
      ADD CONSTRAINT knowledge_space_compile_run_images_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_space_compile_run_pages
      ADD CONSTRAINT knowledge_space_compile_run_pages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_space_compile_runs
      ADD CONSTRAINT knowledge_space_compile_runs_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.labels
      ADD CONSTRAINT labels_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.legacy_link_mappings
      ADD CONSTRAINT legacy_link_mappings_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.notifications
      ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_permissions
      ADD CONSTRAINT page_access_group_unique UNIQUE (page_access_id, group_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_access
      ADD CONSTRAINT page_access_page_id_key UNIQUE (page_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_access
      ADD CONSTRAINT page_access_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_permissions
      ADD CONSTRAINT page_access_user_unique UNIQUE (page_access_id, user_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_history
      ADD CONSTRAINT page_history_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_labels
      ADD CONSTRAINT page_labels_page_id_label_id_unique UNIQUE (page_id, label_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_labels
      ADD CONSTRAINT page_labels_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_permissions
      ADD CONSTRAINT page_permissions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_transclusion_references
      ADD CONSTRAINT page_transclusion_references_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_transclusion_references
      ADD CONSTRAINT page_transclusion_references_unique UNIQUE (reference_page_id, source_page_id, transclusion_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_transclusions
      ADD CONSTRAINT page_transclusions_page_transclusion_unique UNIQUE (page_id, transclusion_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_transclusions
      ADD CONSTRAINT page_transclusions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_verifications
      ADD CONSTRAINT page_verifications_page_id_key UNIQUE (page_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_verifications
      ADD CONSTRAINT page_verifications_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_verifiers
      ADD CONSTRAINT page_verifiers_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_verifiers
      ADD CONSTRAINT page_verifiers_verification_user_unique UNIQUE (page_verification_id, user_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_visits
      ADD CONSTRAINT page_visits_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_visits
      ADD CONSTRAINT page_visits_user_page_unique UNIQUE (user_id, page_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.pages
      ADD CONSTRAINT pages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.pages
      ADD CONSTRAINT pages_slug_id_unique UNIQUE (slug_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.scim_tokens
      ADD CONSTRAINT scim_tokens_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.shares
      ADD CONSTRAINT shares_key_workspace_id_unique UNIQUE (key, workspace_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.shares
      ADD CONSTRAINT shares_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.space_members
      ADD CONSTRAINT space_members_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.space_members
      ADD CONSTRAINT space_members_space_id_group_id_unique UNIQUE (space_id, group_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.space_members
      ADD CONSTRAINT space_members_space_id_user_id_unique UNIQUE (space_id, user_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.spaces
      ADD CONSTRAINT spaces_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.spaces
      ADD CONSTRAINT spaces_slug_workspace_id_unique UNIQUE (slug, workspace_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.spaces
      ADD CONSTRAINT spaces_workspace_personal_owner_unique UNIQUE (workspace_id, personal_owner_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.templates
      ADD CONSTRAINT templates_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.user_mfa
      ADD CONSTRAINT user_mfa_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.user_mfa
      ADD CONSTRAINT user_mfa_user_id_unique UNIQUE (user_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.user_sessions
      ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.user_tokens
      ADD CONSTRAINT user_tokens_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.users
      ADD CONSTRAINT users_email_workspace_id_unique UNIQUE (email, workspace_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.users
      ADD CONSTRAINT users_id_workspace_unique UNIQUE (id, workspace_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.users
      ADD CONSTRAINT users_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.watchers
      ADD CONSTRAINT watchers_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.workspace_invitations
      ADD CONSTRAINT workspace_invitations_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.workspaces
      ADD CONSTRAINT workspaces_custom_domain_unique UNIQUE (custom_domain);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.workspaces
      ADD CONSTRAINT workspaces_hostname_unique UNIQUE (hostname);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.workspaces
      ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.workspaces
      ADD CONSTRAINT workspaces_stripe_customer_id_unique UNIQUE (stripe_customer_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

--
-- Name: attachments_tsv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS attachments_tsv_idx ON public.attachments USING gin (tsv);

--
-- Name: idx_ai_chat_messages_chat_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_chat_id ON public.ai_chat_messages USING btree (chat_id, id);

--
-- Name: idx_ai_chat_messages_tsv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_tsv ON public.ai_chat_messages USING gin (tsv);

--
-- Name: idx_ai_chats_workspace_creator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_ai_chats_workspace_creator ON public.ai_chats USING btree (workspace_id, creator_id, id);

--
-- Name: idx_analytics_events_page_view_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_analytics_events_page_view_space ON public.analytics_events USING btree (workspace_id, space_id, created_at) WHERE ((event)::text = 'page_view'::text);

--
-- Name: idx_analytics_events_ws_event_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_analytics_events_ws_event_created ON public.analytics_events USING btree (workspace_id, event, created_at);

--
-- Name: idx_api_key_spaces_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_api_key_spaces_space_id ON public.api_key_spaces USING btree (space_id);

--
-- Name: idx_api_keys_active_agent_name_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_active_agent_name_unique ON public.api_keys USING btree (workspace_id, lower(btrim(name))) WHERE (((key_type)::text = 'agent'::text) AND (deleted_at IS NULL));

--
-- Name: idx_api_keys_agent_user_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_agent_user_id_unique ON public.api_keys USING btree (agent_user_id) WHERE (agent_user_id IS NOT NULL);

--
-- Name: idx_api_keys_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_api_keys_workspace_id ON public.api_keys USING btree (workspace_id);

--
-- Name: idx_attachments_ai_chat_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_attachments_ai_chat_id ON public.attachments USING btree (ai_chat_id);

--
-- Name: idx_attachments_page_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_attachments_page_id ON public.attachments USING btree (page_id);

--
-- Name: idx_attachments_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_attachments_space_id ON public.attachments USING btree (space_id);

--
-- Name: idx_attachments_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_attachments_workspace_id ON public.attachments USING btree (workspace_id);

--
-- Name: idx_audit_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_audit_workspace_id ON public.audit USING btree (workspace_id, id DESC);

--
-- Name: idx_auth_accounts_provider_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_auth_accounts_provider_user_id ON public.auth_accounts USING btree (provider_user_id, auth_provider_id);

--
-- Name: idx_auth_providers_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_auth_providers_workspace_id ON public.auth_providers USING btree (workspace_id);

--
-- Name: idx_backlinks_target_page_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_backlinks_target_page_id ON public.backlinks USING btree (target_page_id);

--
-- Name: idx_comments_page_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_comments_page_id ON public.comments USING btree (page_id);

--
-- Name: idx_comments_parent_comment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_comments_parent_comment_id ON public.comments USING btree (parent_comment_id);

--
-- Name: idx_favorites_user_page; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_user_page ON public.favorites USING btree (user_id, page_id) WHERE (page_id IS NOT NULL);

--
-- Name: idx_favorites_user_space; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_user_space ON public.favorites USING btree (user_id, space_id) WHERE (space_id IS NOT NULL);

--
-- Name: idx_favorites_user_template; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_user_template ON public.favorites USING btree (user_id, template_id) WHERE (template_id IS NOT NULL);

--
-- Name: idx_favorites_user_workspace_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_favorites_user_workspace_type ON public.favorites USING btree (user_id, workspace_id, type);

--
-- Name: idx_file_tasks_page_export; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_file_tasks_page_export ON public.file_tasks USING btree (page_id, workspace_id) WHERE (((type)::text = 'export'::text) AND (deleted_at IS NULL));

--
-- Name: idx_group_users_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_group_users_user_id ON public.group_users USING btree (user_id);

--
-- Name: idx_groups_name_lower_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_name_lower_workspace ON public.groups USING btree (lower((name)::text), workspace_id);

--
-- Name: idx_groups_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_groups_workspace_id ON public.groups USING btree (workspace_id);

--
-- Name: idx_groups_workspace_scim_external_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_workspace_scim_external_id ON public.groups USING btree (workspace_id, scim_external_id) WHERE (scim_external_id IS NOT NULL);

--
-- Name: idx_kc_hnsw_b275b56d8daa_1024; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_kc_hnsw_b275b56d8daa_1024 ON public.knowledge_chunks USING hnsw (((embedding)::public.vector(1024)) public.vector_cosine_ops) WHERE (((embedding_profile)::text = 'b275b56d8daa2a5aea4867fba96978cca04154d71ae143dc519aa7c894e1269e'::text) AND (embedding_dimensions = 1024) AND (stale_at IS NULL) AND (embedding IS NOT NULL));

--
-- Name: idx_knowledge_access_policy_fresh; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_access_policy_fresh ON public.knowledge_source_access_policy USING btree (workspace_id, source_page_id) WHERE (stale_at IS NULL);

--
-- Name: idx_knowledge_access_policy_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_access_policy_space ON public.knowledge_source_access_policy USING btree (workspace_id, source_space_id);

--
-- Name: idx_knowledge_access_principals_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_access_principals_lookup ON public.knowledge_source_access_principals USING btree (workspace_id, principal_type, principal_id);

--
-- Name: idx_knowledge_access_principals_requirement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_access_principals_requirement ON public.knowledge_source_access_principals USING btree (workspace_id, source_page_id, requirement_id, principal_type, principal_id);

--
-- Name: idx_knowledge_access_principals_source_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_access_principals_source_page ON public.knowledge_source_access_principals USING btree (workspace_id, source_page_id);

--
-- Name: idx_knowledge_artifact_contributions_artifact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_artifact_contributions_artifact ON public.knowledge_artifact_contributions USING btree (workspace_id, space_id, artifact_id);

--
-- Name: idx_knowledge_chunk_attachments_workspace_chunk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_attachments_workspace_chunk ON public.knowledge_chunk_attachments USING btree (workspace_id, chunk_id);

--
-- Name: idx_knowledge_chunk_sources_acl; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_sources_acl ON public.knowledge_chunk_sources USING btree (workspace_id, chunk_id, source_page_id);

--
-- Name: idx_knowledge_chunk_sources_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_sources_owner ON public.knowledge_chunk_sources USING btree (chunk_id);

--
-- Name: idx_knowledge_chunk_sources_source_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_sources_source_page ON public.knowledge_chunk_sources USING btree (source_page_id);

--
-- Name: idx_knowledge_chunk_sources_workspace_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_sources_workspace_source ON public.knowledge_chunk_sources USING btree (workspace_id, source_page_id);

--
-- Name: idx_knowledge_chunks_active_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_active_channel ON public.knowledge_chunks USING btree (workspace_id, space_id, retrieval_channel, embedding_profile) WHERE (stale_at IS NULL);

--
-- Name: idx_knowledge_chunks_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_channel ON public.knowledge_chunks USING btree (workspace_id, space_id, retrieval_channel) WHERE (stale_at IS NULL);

--
-- Name: idx_knowledge_chunks_embedding_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding_profile ON public.knowledge_chunks USING btree (workspace_id, space_id, embedding_profile) WHERE ((stale_at IS NULL) AND (embedding IS NOT NULL));

--
-- Name: idx_knowledge_chunks_page_fk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_page_fk ON public.knowledge_chunks USING btree (knowledge_page_id);

--
-- Name: idx_knowledge_chunks_parent_section_fk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_parent_section_fk ON public.knowledge_chunks USING btree (parent_section_id) WHERE (parent_section_id IS NOT NULL);

--
-- Name: idx_knowledge_chunks_search_tsv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_search_tsv ON public.knowledge_chunks USING gin (search_tsv);

--
-- Name: idx_knowledge_chunks_search_tsv_zh; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_search_tsv_zh ON public.knowledge_chunks USING gin (search_tsv_zh);

--
-- Name: idx_knowledge_chunks_workspace_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_workspace_space ON public.knowledge_chunks USING btree (workspace_id, space_id);

--
-- Name: idx_knowledge_compilation_attempts_diagnostics; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_compilation_attempts_diagnostics ON public.knowledge_compilation_attempts USING btree (workspace_id, space_id, status, stage, updated_at);

--
-- Name: idx_knowledge_edges_workspace_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_edges_workspace_space ON public.knowledge_graph_edges USING btree (workspace_id, space_id);

--
-- Name: idx_knowledge_embedding_rebuild_batches_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_embedding_rebuild_batches_scope ON public.knowledge_embedding_rebuild_batches USING btree (workspace_id, space_id, created_at DESC);

--
-- Name: idx_knowledge_graph_edge_sources_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_graph_edge_sources_owner ON public.knowledge_graph_edge_sources USING btree (graph_edge_id);

--
-- Name: idx_knowledge_graph_edge_sources_source_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_graph_edge_sources_source_page ON public.knowledge_graph_edge_sources USING btree (source_page_id);

--
-- Name: idx_knowledge_graph_edge_sources_workspace_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_graph_edge_sources_workspace_source ON public.knowledge_graph_edge_sources USING btree (workspace_id, source_page_id);

--
-- Name: idx_knowledge_graph_edges_canonical_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_graph_edges_canonical_target ON public.knowledge_graph_edges USING btree (workspace_id, space_id, target_artifact_kind, target_canonical_key) WHERE (stale_at IS NULL);

--
-- Name: idx_knowledge_graph_edges_from_page_fk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_graph_edges_from_page_fk ON public.knowledge_graph_edges USING btree (from_knowledge_page_id);

--
-- Name: idx_knowledge_graph_edges_to_page_fk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_graph_edges_to_page_fk ON public.knowledge_graph_edges USING btree (to_knowledge_page_id);

--
-- Name: idx_knowledge_link_sources_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_link_sources_owner ON public.knowledge_link_sources USING btree (link_id);

--
-- Name: idx_knowledge_link_sources_source_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_link_sources_source_page ON public.knowledge_link_sources USING btree (source_page_id);

--
-- Name: idx_knowledge_link_sources_workspace_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_link_sources_workspace_source ON public.knowledge_link_sources USING btree (workspace_id, source_page_id);

--
-- Name: idx_knowledge_links_canonical_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_links_canonical_target ON public.knowledge_links USING btree (workspace_id, space_id, target_artifact_kind, target_canonical_key) WHERE ((stale_at IS NULL) AND (is_dangling = true));

--
-- Name: idx_knowledge_links_from_page_fk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_links_from_page_fk ON public.knowledge_links USING btree (from_knowledge_page_id);

--
-- Name: idx_knowledge_links_to_page_fk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_links_to_page_fk ON public.knowledge_links USING btree (to_knowledge_page_id) WHERE (to_knowledge_page_id IS NOT NULL);

--
-- Name: idx_knowledge_links_workspace_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_links_workspace_space ON public.knowledge_links USING btree (workspace_id, space_id);

--
-- Name: idx_knowledge_page_compile_schedules_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_page_compile_schedules_due ON public.knowledge_page_compile_schedules USING btree (eligible_at, id);

--
-- Name: idx_knowledge_page_compile_schedules_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_page_compile_schedules_scope ON public.knowledge_page_compile_schedules USING btree (workspace_id, space_id, eligible_at);

--
-- Name: idx_knowledge_page_sources_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_page_sources_owner ON public.knowledge_page_sources USING btree (knowledge_page_id);

--
-- Name: idx_knowledge_page_sources_source_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_page_sources_source_page ON public.knowledge_page_sources USING btree (source_page_id);

--
-- Name: idx_knowledge_page_sources_workspace_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_page_sources_workspace_source ON public.knowledge_page_sources USING btree (workspace_id, source_page_id);

--
-- Name: idx_knowledge_pages_normalized_title; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_pages_normalized_title ON public.knowledge_pages USING btree (workspace_id, space_id, regexp_replace(lower(TRIM(BOTH FROM title)), '\s+'::text, ' '::text, 'g'::text) text_pattern_ops) WHERE (stale_at IS NULL);

--
-- Name: idx_knowledge_pages_workspace_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_pages_workspace_space ON public.knowledge_pages USING btree (workspace_id, space_id);

--
-- Name: idx_knowledge_parent_section_sources_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_parent_section_sources_page ON public.knowledge_parent_section_sources USING btree (workspace_id, source_page_id);

--
-- Name: idx_knowledge_parent_sections_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_parent_sections_page ON public.knowledge_parent_sections USING btree (workspace_id, knowledge_page_id) WHERE (stale_at IS NULL);

--
-- Name: idx_knowledge_parent_sections_page_fk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_parent_sections_page_fk ON public.knowledge_parent_sections USING btree (knowledge_page_id);

--
-- Name: idx_knowledge_quarantined_artifacts_space_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_quarantined_artifacts_space_created ON public.knowledge_quarantined_artifacts USING btree (workspace_id, space_id, created_at);

--
-- Name: idx_knowledge_quarantined_artifacts_workspace_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_quarantined_artifacts_workspace_created ON public.knowledge_quarantined_artifacts USING btree (workspace_id, created_at);

--
-- Name: idx_knowledge_review_applications_space_item_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_review_applications_space_item_updated ON public.knowledge_review_applications USING btree (workspace_id, space_id, review_item_id, updated_at);

--
-- Name: idx_knowledge_review_applications_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_review_applications_status ON public.knowledge_review_applications USING btree (workspace_id, status);

--
-- Name: idx_knowledge_review_snapshots_workspace_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_review_snapshots_workspace_updated ON public.knowledge_review_snapshots USING btree (workspace_id, updated_at);

--
-- Name: idx_knowledge_run_pages_latest_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_run_pages_latest_source ON public.knowledge_space_compile_run_pages USING btree (workspace_id, source_page_id, updated_at DESC, id DESC);

--
-- Name: idx_knowledge_run_pages_merge_dispatch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_run_pages_merge_dispatch ON public.knowledge_space_compile_run_pages USING btree (merge_status, merge_dispatched_at, updated_at);

--
-- Name: idx_knowledge_source_analyses_workspace_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_source_analyses_workspace_space ON public.knowledge_source_analyses USING btree (workspace_id, space_id);

--
-- Name: idx_knowledge_source_chunks_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_source_chunks_page ON public.knowledge_source_chunks USING btree (workspace_id, source_page_id, created_at DESC);

--
-- Name: idx_knowledge_sources_workspace_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_sources_workspace_space ON public.knowledge_sources USING btree (workspace_id, source_space_id);

--
-- Name: idx_knowledge_space_compile_run_images_diagnostics_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_space_compile_run_images_diagnostics_scope ON public.knowledge_space_compile_run_images USING btree (workspace_id, space_id, status);


--
-- Name: idx_knowledge_space_compile_run_images_extraction_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_space_compile_run_images_extraction_id ON public.knowledge_space_compile_run_images USING btree (extraction_id) WHERE (extraction_id IS NOT NULL);

--
-- Name: idx_knowledge_space_compile_run_images_reaper; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_space_compile_run_images_reaper ON public.knowledge_space_compile_run_images USING btree (status, dispatched_at, updated_at);

--
-- Name: idx_knowledge_space_compile_run_images_run_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_space_compile_run_images_run_status ON public.knowledge_space_compile_run_images USING btree (run_id, status, created_at);

--
-- Name: idx_knowledge_space_compile_run_pages_diagnostics_failed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_space_compile_run_pages_diagnostics_failed ON public.knowledge_space_compile_run_pages USING btree (workspace_id, space_id, error_code) WHERE (((status)::text = 'failed'::text) OR ((merge_status)::text = 'failed'::text));


--
-- Name: idx_knowledge_space_compile_run_pages_dispatch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_space_compile_run_pages_dispatch ON public.knowledge_space_compile_run_pages USING btree (status, run_id, updated_at);

--
-- Name: idx_knowledge_space_compile_runs_diagnostics; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_space_compile_runs_diagnostics ON public.knowledge_space_compile_runs USING btree (workspace_id, space_id, created_at);

--
-- Name: idx_knowledge_space_compile_runs_diagnostics_scope_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_space_compile_runs_diagnostics_scope_status ON public.knowledge_space_compile_runs USING btree (workspace_id, space_id, status, phase);


--
-- Name: idx_knowledge_space_compile_runs_dispatch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_space_compile_runs_dispatch ON public.knowledge_space_compile_runs USING btree (status, updated_at);

--
-- Name: idx_knowledge_space_compile_runs_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_space_compile_runs_retention ON public.knowledge_space_compile_runs USING btree (finished_at, id) INCLUDE (space_id, knowledge_generation, status) WHERE ((finished_at IS NOT NULL) AND ((status)::text = ANY ((ARRAY['succeeded'::character varying, 'partial'::character varying, 'failed'::character varying, 'cancelled'::character varying, 'superseded'::character varying])::text[])));

--
-- Name: idx_knowledge_space_compile_runs_space_dispatch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_space_compile_runs_space_dispatch ON public.knowledge_space_compile_runs USING btree (status, phase, space_job_queued_at);

--
-- Name: idx_knowledge_space_compile_runs_workspace_status_phase; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_space_compile_runs_workspace_status_phase ON public.knowledge_space_compile_runs USING btree (workspace_id, status, phase, updated_at);

--
-- Name: idx_legacy_link_mappings_page_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_link_mappings_page_id ON public.legacy_link_mappings USING btree (workspace_id, source, legacy_page_id);

--
-- Name: idx_legacy_link_mappings_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_legacy_link_mappings_path ON public.legacy_link_mappings USING btree (workspace_id, source, legacy_path);

--
-- Name: idx_legacy_link_mappings_space_title; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_legacy_link_mappings_space_title ON public.legacy_link_mappings USING btree (workspace_id, source, legacy_space_key, legacy_title);

--
-- Name: idx_legacy_link_mappings_workspace_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_legacy_link_mappings_workspace_source ON public.legacy_link_mappings USING btree (workspace_id, source);

--
-- Name: idx_notifications_comment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_notifications_comment_id ON public.notifications USING btree (comment_id);

--
-- Name: idx_notifications_page_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_notifications_page_id ON public.notifications USING btree (page_id);

--
-- Name: idx_notifications_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_notifications_space_id ON public.notifications USING btree (space_id);

--
-- Name: idx_notifications_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON public.notifications USING btree (user_id, id DESC);

--
-- Name: idx_notifications_user_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON public.notifications USING btree (user_id) WHERE (read_at IS NULL);

--
-- Name: idx_page_access_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_page_access_space ON public.page_access USING btree (space_id);

--
-- Name: idx_page_history_page_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_page_history_page_created ON public.page_history USING btree (page_id, created_at DESC);

--
-- Name: idx_page_permissions_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_page_permissions_group ON public.page_permissions USING btree (group_id);

--
-- Name: idx_page_permissions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_page_permissions_user ON public.page_permissions USING btree (user_id);

--
-- Name: idx_page_transclusion_references_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_page_transclusion_references_source ON public.page_transclusion_references USING btree (source_page_id, transclusion_id);

--
-- Name: idx_page_transclusion_references_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_page_transclusion_references_workspace ON public.page_transclusion_references USING btree (workspace_id);

--
-- Name: idx_page_transclusions_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_page_transclusions_workspace ON public.page_transclusions USING btree (workspace_id);

--
-- Name: idx_page_verifications_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_page_verifications_expires_at ON public.page_verifications USING btree (expires_at) WHERE (expires_at IS NOT NULL);

--
-- Name: idx_page_verifications_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_page_verifications_space_id ON public.page_verifications USING btree (space_id);

--
-- Name: idx_page_verifications_workspace_id_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_page_verifications_workspace_id_id ON public.page_verifications USING btree (workspace_id, id DESC);

--
-- Name: idx_page_verifiers_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_page_verifiers_user_id ON public.page_verifiers USING btree (user_id);

--
-- Name: idx_page_visits_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_page_visits_recent ON public.page_visits USING btree (workspace_id, user_id, last_visited_at DESC, id DESC);

--
-- Name: idx_pages_creator_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_pages_creator_id ON public.pages USING btree (creator_id);

--
-- Name: idx_pages_parent_page_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_pages_parent_page_id ON public.pages USING btree (parent_page_id) WHERE (deleted_at IS NULL);

--
-- Name: idx_pages_space_deleted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_pages_space_deleted ON public.pages USING btree (space_id, deleted_at DESC) WHERE (deleted_at IS NOT NULL);

--
-- Name: idx_pages_space_parent_position; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_pages_space_parent_position ON public.pages USING btree (space_id, parent_page_id, "position" COLLATE "C") WHERE (deleted_at IS NULL);

--
-- Name: idx_pages_space_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_pages_space_updated ON public.pages USING btree (space_id, updated_at DESC) WHERE (deleted_at IS NULL);

--
-- Name: idx_pages_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_pages_workspace_id ON public.pages USING btree (workspace_id);

--
-- Name: idx_scim_tokens_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_scim_tokens_token_hash ON public.scim_tokens USING btree (token_hash);

--
-- Name: idx_scim_tokens_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_scim_tokens_workspace_id ON public.scim_tokens USING btree (workspace_id);

--
-- Name: idx_shares_page_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_shares_page_id ON public.shares USING btree (page_id);

--
-- Name: idx_space_members_group_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_space_members_group_id ON public.space_members USING btree (group_id);

--
-- Name: idx_space_members_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_space_members_user_id ON public.space_members USING btree (user_id);

--
-- Name: idx_spaces_slug_lower_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_slug_lower_workspace ON public.spaces USING btree (lower((slug)::text), workspace_id);

--
-- Name: idx_spaces_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_spaces_workspace_id ON public.spaces USING btree (workspace_id);

--
-- Name: idx_templates_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_templates_space_id ON public.templates USING btree (space_id);

--
-- Name: idx_templates_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_templates_workspace_id ON public.templates USING btree (workspace_id);

--
-- Name: idx_user_sessions_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_user_sessions_active ON public.user_sessions USING btree (user_id, workspace_id, last_active_at DESC) WHERE (revoked_at IS NULL);

--
-- Name: idx_user_sessions_revoked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_user_sessions_revoked ON public.user_sessions USING btree (expires_at) WHERE (revoked_at IS NOT NULL);

--
-- Name: idx_user_sessions_user_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_workspace ON public.user_sessions USING btree (user_id, workspace_id);

--
-- Name: idx_users_workspace_deleted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_users_workspace_deleted ON public.users USING btree (workspace_id, deleted_at);

--
-- Name: idx_users_workspace_scim_external_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_workspace_scim_external_id ON public.users USING btree (workspace_id, scim_external_id) WHERE (scim_external_id IS NOT NULL);

--
-- Name: idx_watchers_page_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_watchers_page_id ON public.watchers USING btree (page_id);

--
-- Name: idx_watchers_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_watchers_space_id ON public.watchers USING btree (space_id);

--
-- Name: idx_watchers_user_page; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_watchers_user_page ON public.watchers USING btree (user_id, page_id) WHERE (page_id IS NOT NULL);

--
-- Name: idx_watchers_user_space; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_watchers_user_space ON public.watchers USING btree (user_id, space_id) WHERE (page_id IS NULL);

--
-- Name: idx_watchers_user_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_watchers_user_workspace ON public.watchers USING btree (user_id, workspace_id);

--
-- Name: idx_workspace_invitations_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace_id ON public.workspace_invitations USING btree (workspace_id);

--
-- Name: idx_workspaces_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_workspaces_created_at ON public.workspaces USING btree (created_at);

--
-- Name: idx_workspaces_hostname_lower; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_hostname_lower ON public.workspaces USING btree (lower((hostname)::text));

--
-- Name: knowledge_chunks_text_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS knowledge_chunks_text_trgm_idx ON public.knowledge_chunks USING gin (text public.gin_trgm_ops) WHERE (stale_at IS NULL);

--
-- Name: knowledge_image_extractions_failed_retry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS knowledge_image_extractions_failed_retry_idx ON public.knowledge_image_extractions USING btree (retry_after) WHERE (((status)::text = 'failed'::text) AND (retryable = true));

--
-- Name: knowledge_image_extractions_processing_lease_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS knowledge_image_extractions_processing_lease_idx ON public.knowledge_image_extractions USING btree (lease_expires_at) WHERE ((status)::text = 'processing'::text);

--
-- Name: knowledge_pages_retrieval_mode_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS knowledge_pages_retrieval_mode_idx ON public.knowledge_pages USING btree (workspace_id, space_id, page_type, generation_mode) WHERE (stale_at IS NULL);

--
-- Name: knowledge_pages_title_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS knowledge_pages_title_trgm_idx ON public.knowledge_pages USING gin (title public.gin_trgm_ops) WHERE (stale_at IS NULL);

--
-- Name: labels_workspace_id_type_name_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS labels_workspace_id_type_name_unique ON public.labels USING btree (workspace_id, type, name);

--
-- Name: page_labels_label_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS page_labels_label_id_idx ON public.page_labels USING btree (label_id);

--
-- Name: pages_tsv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS pages_tsv_idx ON public.pages USING gin (tsv);

--
-- Name: templates_tsv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS templates_tsv_idx ON public.templates USING gin (tsv);

--
-- Name: uq_knowledge_artifact_contributions_source_artifact; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_artifact_contributions_source_artifact ON public.knowledge_artifact_contributions USING btree (workspace_id, source_page_id, artifact_id);

--
-- Name: uq_knowledge_compilation_attempts_workspace_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_compilation_attempts_workspace_source ON public.knowledge_compilation_attempts USING btree (workspace_id, source_page_id);

--
-- Name: uq_knowledge_page_compile_schedules_workspace_page; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_page_compile_schedules_workspace_page ON public.knowledge_page_compile_schedules USING btree (workspace_id, source_page_id);

--
-- Name: uq_knowledge_pages_canonical_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_pages_canonical_key ON public.knowledge_pages USING btree (workspace_id, space_id, page_type, canonical_key) WHERE (canonical_key IS NOT NULL);

--
-- Name: uq_knowledge_run_pages_merge_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_run_pages_merge_job_id ON public.knowledge_space_compile_run_pages USING btree (merge_job_id) WHERE (merge_job_id IS NOT NULL);

--
-- Name: uq_knowledge_run_pages_one_outstanding_merge; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_run_pages_one_outstanding_merge ON public.knowledge_space_compile_run_pages USING btree (run_id) WHERE ((merge_status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text]));

--
-- Name: uq_knowledge_source_analyses_cache_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_source_analyses_cache_key ON public.knowledge_source_analyses USING btree (workspace_id, source_page_id, source_content_hash, compiler_version, prompt_version);

--
-- Name: uq_knowledge_space_compile_run_images_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_space_compile_run_images_job_id ON public.knowledge_space_compile_run_images USING btree (job_id) WHERE (job_id IS NOT NULL);

--
-- Name: uq_knowledge_space_compile_run_images_page_ordinal; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_space_compile_run_images_page_ordinal ON public.knowledge_space_compile_run_images USING btree (run_page_id, image_ordinal);

--
-- Name: uq_knowledge_space_compile_run_images_run_source_attachment; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_space_compile_run_images_run_source_attachment ON public.knowledge_space_compile_run_images USING btree (run_id, source_page_id, attachment_id);

--
-- Name: uq_knowledge_space_compile_run_pages_run_page; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_space_compile_run_pages_run_page ON public.knowledge_space_compile_run_pages USING btree (run_id, source_page_id);

--
-- Name: uq_knowledge_space_compile_runs_active_space; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_space_compile_runs_active_space ON public.knowledge_space_compile_runs USING btree (workspace_id, space_id) WHERE ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('compiling'::character varying)::text, ('aggregating'::character varying)::text]));

--
-- Name: ai_chat_messages ai_chat_messages_tsvector_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER ai_chat_messages_tsvector_update BEFORE INSERT OR UPDATE ON public.ai_chat_messages FOR EACH ROW EXECUTE FUNCTION public.ai_chat_messages_tsvector_trigger();

--
-- Name: knowledge_chunks knowledge_chunks_search_tsv_zh_refresh; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER knowledge_chunks_search_tsv_zh_refresh BEFORE INSERT OR UPDATE OF text ON public.knowledge_chunks FOR EACH ROW EXECUTE FUNCTION public.knowledge_chunks_search_tsv_zh_refresh();

--
-- Name: pages pages_tsvector_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER pages_tsvector_update BEFORE INSERT OR UPDATE ON public.pages FOR EACH ROW EXECUTE FUNCTION public.pages_tsvector_trigger();

--
-- Name: templates templates_tsvector_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER templates_tsvector_update BEFORE INSERT OR UPDATE ON public.templates FOR EACH ROW EXECUTE FUNCTION public.templates_tsvector_trigger();

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.ai_chat_messages
      ADD CONSTRAINT ai_chat_messages_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES public.ai_chats(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.ai_chat_messages
      ADD CONSTRAINT ai_chat_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.ai_chat_messages
      ADD CONSTRAINT ai_chat_messages_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.ai_chats
      ADD CONSTRAINT ai_chats_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.ai_chats
      ADD CONSTRAINT ai_chats_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.analytics_events
      ADD CONSTRAINT analytics_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.analytics_events
      ADD CONSTRAINT analytics_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.api_key_spaces
      ADD CONSTRAINT api_key_spaces_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES public.api_keys(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.api_key_spaces
      ADD CONSTRAINT api_key_spaces_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.api_keys
      ADD CONSTRAINT api_keys_agent_user_id_fkey FOREIGN KEY (agent_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.api_keys
      ADD CONSTRAINT api_keys_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.api_keys
      ADD CONSTRAINT api_keys_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.attachments
      ADD CONSTRAINT attachments_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.attachments
      ADD CONSTRAINT attachments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.audit
      ADD CONSTRAINT audit_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.auth_accounts
      ADD CONSTRAINT auth_accounts_auth_provider_id_fkey FOREIGN KEY (auth_provider_id) REFERENCES public.auth_providers(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.auth_accounts
      ADD CONSTRAINT auth_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.auth_accounts
      ADD CONSTRAINT auth_accounts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.auth_providers
      ADD CONSTRAINT auth_providers_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.auth_providers
      ADD CONSTRAINT auth_providers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.backlinks
      ADD CONSTRAINT backlinks_source_page_id_fkey FOREIGN KEY (source_page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.backlinks
      ADD CONSTRAINT backlinks_target_page_id_fkey FOREIGN KEY (target_page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.backlinks
      ADD CONSTRAINT backlinks_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.billing
      ADD CONSTRAINT billing_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.comments
      ADD CONSTRAINT comments_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.comments
      ADD CONSTRAINT comments_last_edited_by_id_fkey FOREIGN KEY (last_edited_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.comments
      ADD CONSTRAINT comments_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.comments
      ADD CONSTRAINT comments_parent_comment_id_fkey FOREIGN KEY (parent_comment_id) REFERENCES public.comments(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.comments
      ADD CONSTRAINT comments_resolved_by_id_fkey FOREIGN KEY (resolved_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.comments
      ADD CONSTRAINT comments_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.comments
      ADD CONSTRAINT comments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.favorites
      ADD CONSTRAINT favorites_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.favorites
      ADD CONSTRAINT favorites_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.favorites
      ADD CONSTRAINT favorites_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.templates(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.favorites
      ADD CONSTRAINT favorites_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.favorites
      ADD CONSTRAINT favorites_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.file_tasks
      ADD CONSTRAINT file_tasks_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.file_tasks
      ADD CONSTRAINT file_tasks_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.file_tasks
      ADD CONSTRAINT file_tasks_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.file_tasks
      ADD CONSTRAINT file_tasks_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.group_users
      ADD CONSTRAINT group_users_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.group_users
      ADD CONSTRAINT group_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.groups
      ADD CONSTRAINT groups_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.groups
      ADD CONSTRAINT groups_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_artifact_contributions
      ADD CONSTRAINT knowledge_artifact_contributions_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_artifact_contributions
      ADD CONSTRAINT knowledge_artifact_contributions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_chunk_attachments
      ADD CONSTRAINT knowledge_chunk_attachments_chunk_id_fkey FOREIGN KEY (chunk_id) REFERENCES public.knowledge_chunks(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_chunk_sources
      ADD CONSTRAINT knowledge_chunk_sources_chunk_id_fkey FOREIGN KEY (chunk_id) REFERENCES public.knowledge_chunks(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_chunk_sources
      ADD CONSTRAINT knowledge_chunk_sources_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_chunks
      ADD CONSTRAINT knowledge_chunks_knowledge_page_id_fkey FOREIGN KEY (knowledge_page_id) REFERENCES public.knowledge_pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_chunks
      ADD CONSTRAINT knowledge_chunks_parent_section_id_fkey FOREIGN KEY (parent_section_id) REFERENCES public.knowledge_parent_sections(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_chunks
      ADD CONSTRAINT knowledge_chunks_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_chunks
      ADD CONSTRAINT knowledge_chunks_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_compilation_attempts
      ADD CONSTRAINT knowledge_compilation_attempts_source_page_id_fkey FOREIGN KEY (source_page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_compilation_attempts
      ADD CONSTRAINT knowledge_compilation_attempts_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_compilation_attempts
      ADD CONSTRAINT knowledge_compilation_attempts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_embedding_rebuild_batches
      ADD CONSTRAINT knowledge_embedding_rebuild_batches_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_embedding_rebuild_batches
      ADD CONSTRAINT knowledge_embedding_rebuild_batches_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_graph_edge_sources
      ADD CONSTRAINT knowledge_graph_edge_sources_graph_edge_id_fkey FOREIGN KEY (graph_edge_id) REFERENCES public.knowledge_graph_edges(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_graph_edge_sources
      ADD CONSTRAINT knowledge_graph_edge_sources_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_graph_edges
      ADD CONSTRAINT knowledge_graph_edges_from_knowledge_page_id_fkey FOREIGN KEY (from_knowledge_page_id) REFERENCES public.knowledge_pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_graph_edges
      ADD CONSTRAINT knowledge_graph_edges_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_graph_edges
      ADD CONSTRAINT knowledge_graph_edges_to_knowledge_page_id_fkey FOREIGN KEY (to_knowledge_page_id) REFERENCES public.knowledge_pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_graph_edges
      ADD CONSTRAINT knowledge_graph_edges_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_image_extractions
      ADD CONSTRAINT knowledge_image_extractions_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.attachments(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_image_extractions
      ADD CONSTRAINT knowledge_image_extractions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_link_sources
      ADD CONSTRAINT knowledge_link_sources_link_id_fkey FOREIGN KEY (link_id) REFERENCES public.knowledge_links(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_link_sources
      ADD CONSTRAINT knowledge_link_sources_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_links
      ADD CONSTRAINT knowledge_links_from_knowledge_page_id_fkey FOREIGN KEY (from_knowledge_page_id) REFERENCES public.knowledge_pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_links
      ADD CONSTRAINT knowledge_links_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_links
      ADD CONSTRAINT knowledge_links_target_page_id_fkey FOREIGN KEY (target_page_id) REFERENCES public.pages(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_links
      ADD CONSTRAINT knowledge_links_target_space_id_fkey FOREIGN KEY (target_space_id) REFERENCES public.spaces(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_links
      ADD CONSTRAINT knowledge_links_to_knowledge_page_id_fkey FOREIGN KEY (to_knowledge_page_id) REFERENCES public.knowledge_pages(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_links
      ADD CONSTRAINT knowledge_links_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_page_compile_schedules
      ADD CONSTRAINT knowledge_page_compile_schedules_source_page_id_fkey FOREIGN KEY (source_page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_page_compile_schedules
      ADD CONSTRAINT knowledge_page_compile_schedules_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_page_compile_schedules
      ADD CONSTRAINT knowledge_page_compile_schedules_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_page_index_settings
      ADD CONSTRAINT knowledge_page_index_settings_source_page_id_fkey FOREIGN KEY (source_page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_page_index_settings
      ADD CONSTRAINT knowledge_page_index_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_page_index_settings
      ADD CONSTRAINT knowledge_page_index_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_page_sources
      ADD CONSTRAINT knowledge_page_sources_knowledge_page_id_fkey FOREIGN KEY (knowledge_page_id) REFERENCES public.knowledge_pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_page_sources
      ADD CONSTRAINT knowledge_page_sources_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_pages
      ADD CONSTRAINT knowledge_pages_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_pages
      ADD CONSTRAINT knowledge_pages_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_parent_section_sources
      ADD CONSTRAINT knowledge_parent_section_sources_parent_section_id_fkey FOREIGN KEY (parent_section_id) REFERENCES public.knowledge_parent_sections(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_parent_section_sources
      ADD CONSTRAINT knowledge_parent_section_sources_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_parent_sections
      ADD CONSTRAINT knowledge_parent_sections_knowledge_page_id_fkey FOREIGN KEY (knowledge_page_id) REFERENCES public.knowledge_pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_parent_sections
      ADD CONSTRAINT knowledge_parent_sections_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_parent_sections
      ADD CONSTRAINT knowledge_parent_sections_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_quarantined_artifacts
      ADD CONSTRAINT knowledge_quarantined_artifacts_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_quarantined_artifacts
      ADD CONSTRAINT knowledge_quarantined_artifacts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_query_audit
      ADD CONSTRAINT knowledge_query_audit_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_query_audit
      ADD CONSTRAINT knowledge_query_audit_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_review_applications
      ADD CONSTRAINT knowledge_review_applications_applied_by_fkey FOREIGN KEY (applied_by) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_review_applications
      ADD CONSTRAINT knowledge_review_applications_created_page_id_fkey FOREIGN KEY (created_page_id) REFERENCES public.pages(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_review_applications
      ADD CONSTRAINT knowledge_review_applications_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_review_applications
      ADD CONSTRAINT knowledge_review_applications_target_page_id_fkey FOREIGN KEY (target_page_id) REFERENCES public.pages(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_review_applications
      ADD CONSTRAINT knowledge_review_applications_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_review_snapshots
      ADD CONSTRAINT knowledge_review_snapshots_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_review_snapshots
      ADD CONSTRAINT knowledge_review_snapshots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_source_access_policy
      ADD CONSTRAINT knowledge_source_access_policy_source_space_id_fkey FOREIGN KEY (source_space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_source_access_policy
      ADD CONSTRAINT knowledge_source_access_policy_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_source_access_principals
      ADD CONSTRAINT knowledge_source_access_principals_source_page_id_fkey FOREIGN KEY (source_page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_source_access_principals
      ADD CONSTRAINT knowledge_source_access_principals_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_source_access_requirements
      ADD CONSTRAINT knowledge_source_access_requirements_restricted_page_id_fkey FOREIGN KEY (restricted_page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_source_access_requirements
      ADD CONSTRAINT knowledge_source_access_requirements_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_source_analyses
      ADD CONSTRAINT knowledge_source_analyses_source_page_id_fkey FOREIGN KEY (source_page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_source_analyses
      ADD CONSTRAINT knowledge_source_analyses_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_source_analyses
      ADD CONSTRAINT knowledge_source_analyses_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_source_chunks
      ADD CONSTRAINT knowledge_source_chunks_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.knowledge_sources(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_source_chunks
      ADD CONSTRAINT knowledge_source_chunks_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_sources
      ADD CONSTRAINT knowledge_sources_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.attachments(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_sources
      ADD CONSTRAINT knowledge_sources_source_space_id_fkey FOREIGN KEY (source_space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_sources
      ADD CONSTRAINT knowledge_sources_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_space_compile_run_images
      ADD CONSTRAINT knowledge_space_compile_run_images_extraction_id_fkey FOREIGN KEY (extraction_id) REFERENCES public.knowledge_image_extractions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_space_compile_run_images
      ADD CONSTRAINT knowledge_space_compile_run_images_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.knowledge_space_compile_runs(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_space_compile_run_images
      ADD CONSTRAINT knowledge_space_compile_run_images_run_page_id_fkey FOREIGN KEY (run_page_id) REFERENCES public.knowledge_space_compile_run_pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_space_compile_run_images
      ADD CONSTRAINT knowledge_space_compile_run_images_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_space_compile_run_images
      ADD CONSTRAINT knowledge_space_compile_run_images_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_space_compile_run_pages
      ADD CONSTRAINT knowledge_space_compile_run_pages_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.knowledge_space_compile_runs(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_space_compile_run_pages
      ADD CONSTRAINT knowledge_space_compile_run_pages_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_space_compile_run_pages
      ADD CONSTRAINT knowledge_space_compile_run_pages_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_space_compile_runs
      ADD CONSTRAINT knowledge_space_compile_runs_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.knowledge_space_compile_runs
      ADD CONSTRAINT knowledge_space_compile_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.labels
      ADD CONSTRAINT labels_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.legacy_link_mappings
      ADD CONSTRAINT legacy_link_mappings_import_task_id_fkey FOREIGN KEY (import_task_id) REFERENCES public.file_tasks(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.legacy_link_mappings
      ADD CONSTRAINT legacy_link_mappings_target_attachment_id_fkey FOREIGN KEY (target_attachment_id) REFERENCES public.attachments(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.legacy_link_mappings
      ADD CONSTRAINT legacy_link_mappings_target_page_id_fkey FOREIGN KEY (target_page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.legacy_link_mappings
      ADD CONSTRAINT legacy_link_mappings_target_space_id_fkey FOREIGN KEY (target_space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.legacy_link_mappings
      ADD CONSTRAINT legacy_link_mappings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.notifications
      ADD CONSTRAINT notifications_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.notifications
      ADD CONSTRAINT notifications_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES public.comments(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.notifications
      ADD CONSTRAINT notifications_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.notifications
      ADD CONSTRAINT notifications_page_verification_id_fkey FOREIGN KEY (page_verification_id) REFERENCES public.page_verifications(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.notifications
      ADD CONSTRAINT notifications_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.notifications
      ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.notifications
      ADD CONSTRAINT notifications_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_access
      ADD CONSTRAINT page_access_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_access
      ADD CONSTRAINT page_access_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_access
      ADD CONSTRAINT page_access_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_access
      ADD CONSTRAINT page_access_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_history
      ADD CONSTRAINT page_history_last_updated_by_id_fkey FOREIGN KEY (last_updated_by_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_history
      ADD CONSTRAINT page_history_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_history
      ADD CONSTRAINT page_history_previous_history_id_fkey FOREIGN KEY (previous_history_id) REFERENCES public.page_history(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_history
      ADD CONSTRAINT page_history_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_history
      ADD CONSTRAINT page_history_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_labels
      ADD CONSTRAINT page_labels_label_id_fkey FOREIGN KEY (label_id) REFERENCES public.labels(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_labels
      ADD CONSTRAINT page_labels_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_permissions
      ADD CONSTRAINT page_permissions_added_by_id_fkey FOREIGN KEY (added_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_permissions
      ADD CONSTRAINT page_permissions_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_permissions
      ADD CONSTRAINT page_permissions_page_access_id_fkey FOREIGN KEY (page_access_id) REFERENCES public.page_access(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_permissions
      ADD CONSTRAINT page_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_transclusion_references
      ADD CONSTRAINT page_transclusion_references_reference_page_id_fkey FOREIGN KEY (reference_page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_transclusion_references
      ADD CONSTRAINT page_transclusion_references_source_page_id_fkey FOREIGN KEY (source_page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_transclusion_references
      ADD CONSTRAINT page_transclusion_references_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_transclusions
      ADD CONSTRAINT page_transclusions_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_transclusions
      ADD CONSTRAINT page_transclusions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_verifications
      ADD CONSTRAINT page_verifications_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_verifications
      ADD CONSTRAINT page_verifications_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_verifications
      ADD CONSTRAINT page_verifications_rejected_by_id_fkey FOREIGN KEY (rejected_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_verifications
      ADD CONSTRAINT page_verifications_requested_by_id_fkey FOREIGN KEY (requested_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_verifications
      ADD CONSTRAINT page_verifications_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_verifications
      ADD CONSTRAINT page_verifications_verified_by_id_fkey FOREIGN KEY (verified_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_verifications
      ADD CONSTRAINT page_verifications_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_verifiers
      ADD CONSTRAINT page_verifiers_added_by_id_fkey FOREIGN KEY (added_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_verifiers
      ADD CONSTRAINT page_verifiers_page_verification_id_fkey FOREIGN KEY (page_verification_id) REFERENCES public.page_verifications(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_verifiers
      ADD CONSTRAINT page_verifiers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_visits
      ADD CONSTRAINT page_visits_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_visits
      ADD CONSTRAINT page_visits_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.page_visits
      ADD CONSTRAINT page_visits_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.pages
      ADD CONSTRAINT pages_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.pages
      ADD CONSTRAINT pages_deleted_by_id_fkey FOREIGN KEY (deleted_by_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.pages
      ADD CONSTRAINT pages_last_updated_by_id_fkey FOREIGN KEY (last_updated_by_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.pages
      ADD CONSTRAINT pages_parent_page_id_fkey FOREIGN KEY (parent_page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.pages
      ADD CONSTRAINT pages_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.pages
      ADD CONSTRAINT pages_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.scim_tokens
      ADD CONSTRAINT scim_tokens_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.scim_tokens
      ADD CONSTRAINT scim_tokens_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.shares
      ADD CONSTRAINT shares_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.shares
      ADD CONSTRAINT shares_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.shares
      ADD CONSTRAINT shares_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.shares
      ADD CONSTRAINT shares_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.space_members
      ADD CONSTRAINT space_members_added_by_id_fkey FOREIGN KEY (added_by_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.space_members
      ADD CONSTRAINT space_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.space_members
      ADD CONSTRAINT space_members_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.space_members
      ADD CONSTRAINT space_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.spaces
      ADD CONSTRAINT spaces_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.spaces
      ADD CONSTRAINT spaces_personal_owner_workspace_fk FOREIGN KEY (personal_owner_id, workspace_id) REFERENCES public.users(id, workspace_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.spaces
      ADD CONSTRAINT spaces_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.templates
      ADD CONSTRAINT templates_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.templates
      ADD CONSTRAINT templates_last_updated_by_id_fkey FOREIGN KEY (last_updated_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.templates
      ADD CONSTRAINT templates_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.templates
      ADD CONSTRAINT templates_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.user_mfa
      ADD CONSTRAINT user_mfa_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.user_mfa
      ADD CONSTRAINT user_mfa_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.user_sessions
      ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.user_sessions
      ADD CONSTRAINT user_sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.user_tokens
      ADD CONSTRAINT user_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.user_tokens
      ADD CONSTRAINT user_tokens_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.users
      ADD CONSTRAINT users_invited_by_id_fkey FOREIGN KEY (invited_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.users
      ADD CONSTRAINT users_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.watchers
      ADD CONSTRAINT watchers_added_by_id_fkey FOREIGN KEY (added_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.watchers
      ADD CONSTRAINT watchers_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.watchers
      ADD CONSTRAINT watchers_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.watchers
      ADD CONSTRAINT watchers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.watchers
      ADD CONSTRAINT watchers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.workspace_invitations
      ADD CONSTRAINT workspace_invitations_invited_by_id_fkey FOREIGN KEY (invited_by_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.workspace_invitations
      ADD CONSTRAINT workspace_invitations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;

DO $wrap$
BEGIN
  ALTER TABLE ONLY public.workspaces
      ADD CONSTRAINT workspaces_default_space_id_fkey FOREIGN KEY (default_space_id) REFERENCES public.spaces(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN
  NULL;
END;
$wrap$;
