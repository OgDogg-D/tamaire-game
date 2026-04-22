# 🍭 たまいれらんぶ — おかしを あつめよう！

そらから おちてくる おかしを、ぐるぐる まわる しかくい はこに キャッチする、こども むけの かわいい たまいれゲームです。

![たまいれらんぶ](https://img.shields.io/badge/game-static%20web-ff6fa8)

## あそびかた

1. **「はじめる」** ボタンを おす
2. がめんの したから うえに、ゆびで シュッ！と スワイプ（マウスなら ドラッグ）
3. **はやさ** ＝ たまが とぶ ながさ
4. **むき** ＝ たまが とぶ ほうこう
5. ぐるぐる まわる 🎯 の しかくに いれたら **あたり！**

## モード

- **フリー**：なんかいでも あそべる れんしゅう モード
- **ランキング**：3かい はずしたら おわり・ベスト5を めざそう

## むずかしさ

- **やさしい**：あたり はんていが ひろい
- **ふつう**：ちょうどいい（デフォルト）
- **むずかしい**：あたり はんていが せまい

## つかえる たま

- おてだま
- くだもの
- うんまるくん
- うんひめちゃん

## ローカルで あそぶ

```bash
# リポジトリを クローン
git clone https://github.com/<your-name>/tamaire-game.git
cd tamaire-game

# てきとうな ローカルサーバーで ひらく
# (ただ index.html を ダブルクリックしても うごきます)
python -m http.server 8000
# → http://localhost:8000 を ブラウザで ひらく
```

## ファイル こうせい

```
tamaire-game/
├── index.html     # ぜんたいの ページ こうぞう
├── style.css      # UI の デザイン
├── game.js        # ゲーム ロジック・えがく しょり（Canvas）
└── ranking.js     # なまえ とうろく・ベスト 5 ランキング（localStorage）
```

フレームワーク なし、ビルド ふよう、じゅんすいな HTML + CSS + JavaScript。

## ぎじゅつ

- HTML5 Canvas（2D）で 3Dふうの えんしん とうえい
- `localStorage` で プレイヤーめい・ランキングを ほぞん
- レスポンシブ デザイン（スマホ / タブレット / PC）
- Google Fonts: M PLUS Rounded 1c / Mochiy Pop One / Hachi Maru Pop / Yusei Magic

## ライセンス

MIT
