import type { ReactNode } from "react";
import {
  messageCode,
  messageText,
  troubleshootingUrl,
  type ApiMessage,
} from "../lib/troubleshooting";
import { linkClass } from "./ui";

/** "How to fix this": the message's entry on the troubleshooting page, by its code. */
export function FixLink({
  code,
  className = "",
}: {
  code: string | undefined;
  className?: string;
}) {
  if (!code) return null;
  return (
    <a className={`${linkClass} whitespace-nowrap ${className}`} href={troubleshootingUrl(code)}>
      How to fix this<span className="sr-only"> (troubleshooting: {code})</span>
    </a>
  );
}

/**
 * A problem sentence from the API, with advice under it when the page has some, and its link to
 * the troubleshooting page.
 */
export function ProblemText({
  message,
  advice,
  prefix,
}: {
  message: ApiMessage;
  advice?: ReactNode;
  /** Words before the sentence, e.g. "Worth fixing:". */
  prefix?: string;
}) {
  return (
    <>
      <span className="font-medium">
        {prefix ? `${prefix} ` : ""}
        {messageText(message)}
      </span>{" "}
      <FixLink code={messageCode(message)} className="text-xs" />
      {advice && <span className="mt-0.5 block text-soft">{advice}</span>}
    </>
  );
}
