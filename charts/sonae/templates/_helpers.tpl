{{/*
名前は release 名を使わず固定にしてある (sonae・voicevox・sonae-data)。VOICEVOX_URL・Secret・VolSync の
ReplicationSource など、外から名前で参照されるものがあるため。sonae は 1 つの名前空間に 1 つ立てる
(2 つ立つと情報源への接続も Web Push も倍になる。docs/design.md の 2.1)
*/}}
{{- define "sonae.labels" -}}
app.kubernetes.io/name: sonae
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}

{{/* PVC の名前。existingClaim があればそれ、無ければ chart が作る sonae-data */}}
{{- define "sonae.pvcName" -}}
{{- .Values.persistence.existingClaim | default "sonae-data" -}}
{{- end }}

{{/* 入口のホスト名 (httpRoute.hostnames、空なら ingress.hosts) */}}
{{- define "sonae.hostnames" -}}
{{- toJson (.Values.httpRoute.hostnames | default .Values.ingress.hosts | default list) -}}
{{- end }}

{{/* 公開の URL。sonae.publicUrl、空なら入口の先頭のホスト名に https:// を付けたもの */}}
{{- define "sonae.publicUrl" -}}
{{- $hosts := include "sonae.hostnames" . | fromJsonArray -}}
{{- if .Values.sonae.publicUrl -}}
{{- .Values.sonae.publicUrl | trimSuffix "/" -}}
{{- else if $hosts -}}
{{- printf "https://%s" (first $hosts) -}}
{{- end -}}
{{- end }}
