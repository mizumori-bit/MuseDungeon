# Bot 確認用（捨てラン）— 先輩のPCでの pilot 起動パッケージ

捨てラン `run_aab99529a1`（COOP、V4-1f / engine 0.33.0）の Bot（p_1evt）を、先輩のPCで動かすためのもの。

## 入っているもの

- `token.txt` — Bot（p_1evt）のプレイヤートークン。捨てラン専用。**他人に見せないこと。**
- `respond-v41f.ts` — pilot の返事役（--wake-cmd）。V4-1f 用。camp で最初の遠征を自動開始し、escalate は記録だけして返事しない。それ以外は付属の simpleResponder に任せる。
- `pilot-bot-test.bat` — pilot の起動スクリプト。ダブルクリックで起動。

## 手順

1. この3つのファイルを、先輩のPCの MuseDungeon リポジトリのルート（一番上のフォルダ、`package.json` がある場所）に置く。
2. MuseDungeon サーバーが起動していることを確認する（7777番）。止まっていたら起動する。
3. `pilot-bot-test.bat` をダブルクリックする。Bot（pilot）が起動し、捨てランの最初の遠征を始める。
4. 先輩がブラウザから捨てラン `run_aab99529a1`（Bot確認用（捨て））に入って、2人目のプレイヤーとして動く。Bot がついてくるか確認する。
5. 相方の Muse（ミュゼ美が別に立てる）も3人目として入って、一緒に遊ぶ。
6. Bot を止めるときは、pilot の窓を閉じるか Ctrl+C。

## 注意

- `token.txt` は捨てラン専用のトークン。メインラン（run_edc690bf51）のトークンではない。
- pilot のログは `bot-test-pilot/` フォルダ（orders.json / state.json / log.jsonl / escalations.log / wakes.log）に出る。
- 遠征が終わってキャンプに戻ったとき、Bot はすぐ次の遠征を始めない。次の遠征は手で始める。
