import { isAutoReplyInbound, isBounceInbound, toHeaderMap } from "@/lib/outreach/inbox";

type Case = {
  name: string;
  signals: Parameters<typeof isBounceInbound>[0];
  bounce: boolean;
  auto: boolean;
};

const cases: Case[] = [
  {
    name: "Hidden Level NDR (typographic apostrophe, 5.1.10)",
    signals: {
      fromEmail: "postmaster@hiddenlevel.com",
      subject: "Undeliverable: quick question",
      snippet:
        "Your message to msinsabaugh@hiddenlevel.com couldn’t be delivered. 550 5.1.10 RESOLVER.ADR.RecipientNotFound",
    },
    bounce: true,
    auto: false,
  },
  {
    name: "5.1.3 DSN, no known phrase, no daemon in From",
    signals: {
      fromEmail: "mail@corp.example.com",
      subject: "Delivery report",
      snippet: "Remote server returned 550 5.1.3 bad recipient address syntax",
    },
    bounce: true,
    auto: false,
  },
  {
    name: "5.7.1 blocked, Portuguese",
    signals: {
      fromEmail: "sistema@exemplo.com.br",
      subject: "Falha na entrega",
      snippet: "A mensagem não pôde ser entregue ao destinatário. 5.7.1",
    },
    bounce: true,
    auto: false,
  },
  {
    name: "multipart/report header alone (unknown language body)",
    signals: {
      fromEmail: "noreply@example.jp",
      subject: "配信不能",
      snippet: "メッセージを配信できませんでした",
      headers: toHeaderMap([
        { name: "Content-Type", value: "multipart/report; report-type=delivery-status; boundary=x" },
      ]),
    },
    bounce: true,
    auto: false,
  },
  {
    name: "null envelope sender alone",
    signals: {
      fromEmail: "mailer@example.com",
      subject: "Delivery report",
      snippet: "see attachment",
      headers: toHeaderMap([{ name: "Return-Path", value: "<>" }]),
    },
    bounce: true,
    auto: false,
  },
  {
    name: "Tim out-of-office (text only, the case that broke)",
    signals: {
      fromEmail: "tim@hiddenlevel.com",
      subject: "Automatic reply: quick question",
      snippet: "I am out of office until 8/10/26 with limited access to email.",
    },
    bounce: false,
    auto: true,
  },
  {
    name: "Office 365 OOO with no giveaway text, header only",
    signals: {
      fromEmail: "tim@example.com",
      subject: "Re: quick question",
      snippet: "Back next week — contact Sarah for anything urgent.",
      headers: toHeaderMap([
        { name: "Auto-Submitted", value: "auto-replied" },
        { name: "X-Auto-Response-Suppress", value: "All" },
      ]),
    },
    bounce: false,
    auto: true,
  },
  {
    name: "Brazilian OOO",
    signals: {
      fromEmail: "joao@exemplo.com.br",
      subject: "Resposta automática: proposta",
      snippet: "Estou de férias até 15/08.",
    },
    bounce: false,
    auto: true,
  },
  {
    name: "real human reply",
    signals: {
      fromEmail: "tim@hiddenlevel.com",
      subject: "Re: quick question",
      snippet: "Interesting — can you send pricing? We use GitHub and 5.1.3k LOC/day.",
      headers: toHeaderMap([
        { name: "From", value: "Tim <tim@hiddenlevel.com>" },
        { name: "Return-Path", value: "<tim@hiddenlevel.com>" },
      ]),
    },
    bounce: false,
    auto: false,
  },
  {
    name: "human reply mentioning being out last week",
    signals: {
      fromEmail: "tim@hiddenlevel.com",
      subject: "Re: quick question",
      snippet: "Sorry for the delay, we can talk Thursday.",
    },
    bounce: false,
    auto: false,
  },
  {
    name: "human reply, Auto-Submitted: no",
    signals: {
      fromEmail: "tim@hiddenlevel.com",
      subject: "Re: quick question",
      snippet: "Sounds good, send the deck.",
      headers: toHeaderMap([{ name: "Auto-Submitted", value: "no" }]),
    },
    bounce: false,
    auto: false,
  },
];

let failed = 0;
for (const c of cases) {
  const bounce = isBounceInbound(c.signals);
  const auto = isAutoReplyInbound(c.signals);
  const ok = bounce === c.bounce && auto === c.auto;
  if (!ok) failed++;
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${c.name}\n      bounce=${bounce} (want ${c.bounce})  auto=${auto} (want ${c.auto})`,
  );
}
console.log(failed ? `\n${failed} failing` : `\nall ${cases.length} pass`);
process.exit(failed ? 1 : 0);
