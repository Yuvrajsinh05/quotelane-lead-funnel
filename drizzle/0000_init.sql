CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"consent_version" text NOT NULL,
	"consent_text" text NOT NULL,
	"consented_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"page_url" text NOT NULL,
	CONSTRAINT "consents_lead_id_unique" UNIQUE("lead_id")
);
--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"http_status" integer,
	"outcome" text NOT NULL,
	"error_class" text
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"brand" text NOT NULL,
	"variant" text NOT NULL,
	"variant_source" text NOT NULL,
	"zip" text NOT NULL,
	"vehicle_year" smallint,
	"vehicle_make" text,
	"insured" boolean NOT NULL,
	"age_range" text,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"phone_e164" text NOT NULL,
	"field_provenance" jsonb NOT NULL,
	"ql_click_id" text,
	"aff_click_id" text,
	"aff_id" text,
	"channel" text,
	"channel_raw" text,
	"sub_ids" jsonb,
	"tracking_source" text NOT NULL,
	"landed_at" timestamp with time zone,
	"routing_profile" text NOT NULL,
	"routing_fallback" boolean DEFAULT false NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"visitor_id" text,
	"ip" "inet",
	"user_agent" text,
	CONSTRAINT "leads_variant_ck" CHECK ("leads"."variant" in ('a','b'))
);
--> statement-breakpoint
CREATE TABLE "partner_deliveries" (
	"lead_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_http_status" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_deliveries_status_ck" CHECK ("partner_deliveries"."status" in ('pending','sending','retry_wait','delivered','failed','skipped_unconfigured'))
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limits_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_deliveries" ADD CONSTRAINT "partner_deliveries_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_attempts_lead_idx" ON "delivery_attempts" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_public_id_uq" ON "leads" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_idempotency_key_uq" ON "leads" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "leads_email_created_idx" ON "leads" USING btree ("email_normalized","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "leads_phone_created_idx" ON "leads" USING btree ("phone_e164","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "leads_reporting_idx" ON "leads" USING btree ("created_at" DESC NULLS LAST,"brand","channel","variant");--> statement-breakpoint
CREATE INDEX "partner_deliveries_sweep_idx" ON "partner_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "rate_limits_window_idx" ON "rate_limits" USING btree ("window_start");