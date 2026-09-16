import type { ReactNode } from "react";
import { parseLegalMarkup, type Block, type Inline } from "@/lib/legal/markup";
import { supportContact, UNSET_CONTACT_SENTENCE } from "@/lib/legal/contact";
import { BROWSER_STORAGE, STORAGE_KIND_LABELS } from "@/lib/legal/storage-inventory";
import { SUB_PROCESSORS } from "@/lib/legal/sub-processors";

// Renders a stored legal-document body.
//
// THE ONLY PATH FROM STORED TEXT TO THE PAGE, and it produces React elements
// from typed blocks (lib/legal/markup.ts) -- no HTML string exists anywhere in
// it, and `dangerouslySetInnerHTML` appears nowhere under components/legal
// (tests/unit/legal/renderer.test.tsx asserts that of the source, as well as
// rendering hostile input). Link targets reaching this file have already
// passed safeHref(); a target that did not was reduced to its text by the
// parser.

function Inlines({ content, contactAddress }: { content: readonly Inline[]; contactAddress: string | null }) {
  return (
    <>
      {content.map((part, index) => {
        switch (part.kind) {
          case "text":
            return <span key={index}>{part.text}</span>;
          case "strong":
            return (
              <strong key={index} className="font-semibold text-ink">
                {part.text}
              </strong>
            );
          case "link": {
            const external = part.href.startsWith("https://");
            return (
              <a
                key={index}
                href={part.href}
                className="text-primary underline underline-offset-4 hover:text-ink"
                {...(external ? { rel: "noopener noreferrer" } : {})}
              >
                {part.text}
              </a>
            );
          }
          case "support-email":
            return contactAddress ? (
              <a
                key={index}
                href={`mailto:${contactAddress}`}
                translate="no"
                className="break-all text-primary underline underline-offset-4 hover:text-ink"
                data-testid="support-contact"
              >
                {contactAddress}
              </a>
            ) : (
              <em key={index} className="text-ink" data-testid="support-contact-unset">
                ({UNSET_CONTACT_SENTENCE})
              </em>
            );
        }
      })}
    </>
  );
}

function TableFrame({ caption, children }: { caption: string; children: ReactNode }) {
  // Wider than a phone on purpose (four columns of prose), so it scrolls in
  // its own box rather than the page -- and the box is focusable so a
  // keyboard user can scroll it too.
  return (
    <div
      className="my-6 overflow-x-auto border border-rule"
      role="region"
      aria-label={caption}
      tabIndex={0}
    >
      <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

const TH = "border-b border-rule bg-surface px-3 py-2 text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase";
const TD = "border-b border-rule px-3 py-3 align-top text-ink";

function StorageInventoryTable() {
  return (
    <TableFrame caption="Cookies and browser storage set by GetSetPaid">
      <thead>
        <tr>
          <th scope="col" className={TH}>Name</th>
          <th scope="col" className={TH}>Type</th>
          <th scope="col" className={TH}>Purpose</th>
          <th scope="col" className={TH}>How long</th>
        </tr>
      </thead>
      <tbody>
        {BROWSER_STORAGE.map((item) => (
          <tr key={item.name}>
            <th scope="row" className={`${TD} font-semibold break-words`} translate="no">
              {item.name}
            </th>
            <td className={TD}>{STORAGE_KIND_LABELS[item.kind]}, set by {item.setBy}</td>
            <td className={TD}>
              {item.purpose} <span className="text-ink-muted">{item.necessity}</span>
            </td>
            <td className={TD}>{item.duration}</td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}

function SubprocessorsTable() {
  return (
    <TableFrame caption="Subprocessors">
      <thead>
        <tr>
          <th scope="col" className={TH}>Provider</th>
          <th scope="col" className={TH}>What it does</th>
          <th scope="col" className={TH}>Personal data</th>
          <th scope="col" className={TH}>Location and transfer basis</th>
          <th scope="col" className={TH}>Data processing agreement</th>
        </tr>
      </thead>
      <tbody>
        {SUB_PROCESSORS.map((vendor) => (
          <tr key={vendor.name}>
            <th scope="row" className={`${TD} font-semibold`}>
              {vendor.name}
            </th>
            <td className={TD}>{vendor.purpose}</td>
            <td className={TD}>{vendor.personalData}</td>
            <td className={TD}>
              {vendor.location}. <span className="text-ink-muted">{vendor.transferBasis}</span>
            </td>
            <td className={TD}>{vendor.dpaSigned ? "Signed" : "Not yet signed"}</td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}

type SectionLevel = 2 | 3 | 4 | 5;
const HEADING_TAGS = { 2: "h2", 3: "h3", 4: "h4", 5: "h5", 6: "h6" } as const;

function BlockView({
  block,
  contactAddress,
  sectionLevel,
}: {
  block: Block;
  contactAddress: string | null;
  sectionLevel: SectionLevel;
}) {
  switch (block.kind) {
    case "heading": {
      // `##` renders at the document's section level, `###` one below it.
      if (block.level === 2) {
        const Section = HEADING_TAGS[sectionLevel];
        return (
          <Section className="mt-10 mb-3 text-xl font-extrabold text-ink">
            <Inlines content={block.content} contactAddress={contactAddress} />
          </Section>
        );
      }
      const Sub = HEADING_TAGS[(sectionLevel + 1) as 3 | 4 | 5 | 6];
      return (
        <Sub className="mt-6 mb-2 text-lg font-bold text-ink">
          <Inlines content={block.content} contactAddress={contactAddress} />
        </Sub>
      );
    }
    case "paragraph":
      return (
        <p className="my-4 text-base text-ink">
          <Inlines content={block.content} contactAddress={contactAddress} />
        </p>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index} className="pl-1">
          <Inlines content={item} contactAddress={contactAddress} />
        </li>
      ));
      return block.ordered ? (
        <ol className="my-4 flex list-decimal flex-col gap-2 pl-6 text-base text-ink">{items}</ol>
      ) : (
        <ul className="my-4 flex list-disc flex-col gap-2 pl-6 text-base text-ink">{items}</ul>
      );
    }
    case "subprocessors":
      return <SubprocessorsTable />;
    case "storage-inventory":
      return <StorageInventoryTable />;
  }
}

export function LegalBody({
  source,
  contactAddress = supportContact().address,
  sectionLevel = 2,
}: {
  source: string;
  /** Injected by tests; defaults to SUPPORT_CONTACT_EMAIL. */
  contactAddress?: string | null;
  /** The level `##` renders at: 2 on the public page, under its <h1>. */
  sectionLevel?: SectionLevel;
}) {
  const { blocks } = parseLegalMarkup(source);
  return (
    <div className="break-words" data-testid="legal-body">
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} contactAddress={contactAddress} sectionLevel={sectionLevel} />
      ))}
    </div>
  );
}
