import { GOOGLE_PRIVACY, YOUTUBE_TERMS } from "#lib/map/livecams.ts";

/**
 * プライバシーポリシー (ログイン無しで開ける。docs/design.md の 2.13)。YouTube API Services の Developer Policies
 * (III.A) は、API を使うアプリに、誰でも読める所にプライバシーポリシーを置くことを求める。中身は、YouTube API Services
 * を使うこと・Google のプライバシーポリシーへのリンク・第三者が Cookie などで情報を集めること。
 *
 * ルートのレイアウトはログインの後ろの「いまの姿」を読むので、ページ (+page.svelte) にせず、ここで HTML を返す
 * (ログインしていない人に、受けた情報を渡さない)
 */
const HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>sonae のプライバシーポリシー</title>
<style>
  body { margin: 0 auto; max-width: 40rem; padding: 1.5rem 1rem 3rem; font: 16px/1.8 system-ui, sans-serif; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  a { color: LinkText; }
</style>
</head>
<body>
<h1>sonae のプライバシーポリシー</h1>
<p>sonae は、地震・津波・火山・気象の情報を家のサーバーで受けて、家族の端末で見るためのアプリです。このサーバーは、立てた人が自分と家族のために動かしています。運営と、このポリシーの責任は、このサーバーを立てた人にあります。</p>

<h2>このサーバーが持つもの</h2>
<ul>
<li>ログインした人の名前と、ログインの印 (Cookie)。</li>
<li>通知の設定 (住んでいる地域・知らせる範囲)。Web Push や Webhook で知らせるための、ブラウザの購読の情報と送り先の URL。</li>
<li>端末の位置は、地図に描くだけで、このサーバーには送りません。</li>
<li>地図のタイルや場所の検索は、このサーバーが代わりに配信元 (気象庁・国土地理院など) から取ります。配信元には端末の IP や Cookie は届きません。場所の検索で打った文字は、国土地理院へ問い合わせるために通すだけで、覚えず、記録にも残しません。</li>
<li>地図の「地震の備え」の図 (J-SHIS) を選んだときと、ライブカメラを再生するときだけは、端末のブラウザが配信元 (防災科学技術研究所の J-SHIS・YouTube) へ直接つなぎます。</li>
</ul>
<p>これらは知らせを届けるためだけに使い、ほかの人や会社には渡しません。</p>

<h2>YouTube API Services</h2>
<p>sonae は、地図のライブカメラ (国や自治体の YouTube のライブ配信) を出すために、YouTube API Services を使っています。</p>
<ul>
<li>このサーバーは、YouTube Data API で、表にあるライブカメラがいま配信中かを確かめます。送るのはチャンネルと動画の ID だけで、使う人の情報は送りません。</li>
<li>ライブカメラの印を押すと、端末のブラウザが YouTube の埋め込みのプレーヤー (プライバシー強化モード、youtube-nocookie.com) を読み込み、YouTube (Google) へ直接つなぎます。押すまでは読み込みません。</li>
<li>プレーヤーを読み込むと、YouTube (Google) などの第三者が、Cookie や似た仕組みで端末に情報を置いたり、端末から情報を読んだりすることがあります。その扱いは Google のプライバシーポリシーに従います: <a href="${GOOGLE_PRIVACY}">${GOOGLE_PRIVACY}</a></li>
<li>ライブカメラを見る人は、YouTube の利用規約に従います: <a href="${YOUTUBE_TERMS}">${YOUTUBE_TERMS}</a></li>
<li>Google のセキュリティ設定のページ (<a href="https://security.google.com/settings/security/permissions">https://security.google.com/settings/security/permissions</a>) は、Google アカウントでアプリに許したことを取り消す所です。sonae は Google アカウントでのログインや、使う人のアカウントへのアクセスを求めません。</li>
</ul>

<h2>問い合わせ</h2>
<p>このサーバーについては、このサーバーを立てた人に聞いてください。sonae のコードは <a href="https://github.com/danything/sonae">https://github.com/danything/sonae</a> (AGPL-3.0) にあります。</p>
</body>
</html>
`;

export const GET = () =>
  new Response(HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
