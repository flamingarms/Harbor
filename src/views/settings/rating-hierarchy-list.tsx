import { useRatingHierarchyOrder } from "@/lib/ratings/hierarchy";
import { RATING_PROVIDER_LABELS } from "@/lib/ratings/hierarchy-order";
import { useT } from "@/lib/i18n";
import { ChevronDown, ChevronUp } from "./icons";
import { RowDesc, RowText, RowTitle, Section } from "./shared";
import { ROW_ACTION } from "./kit";

/**
 * The rating hierarchy, shown identically at the bottom of the Trakt, Simkl
 * and Letterboxd settings panels. When several connected trackers have rated
 * the same title, the Detail page shows the first rating found reading down
 * this list. Newly connected trackers join at the bottom in login order.
 */
export function RatingHierarchyList() {
  const t = useT();
  const { order, move } = useRatingHierarchyOrder();

  if (order.length === 0) return null;

  return (
    <Section
      title={t("Rating hierarchy")}
      subtitle={t(
        "When several connected services have rated the same title, the details page shows the first rating found reading down this list. Newly connected services join at the bottom.",
      )}
    >
      <div className="flex flex-col">
        {order.map((provider, idx) => (
          <div key={provider} className="hset-row">
            <RowText>
              <RowTitle>
                <span className="min-w-0">
                  {idx + 1}. {RATING_PROVIDER_LABELS[provider]}
                </span>
              </RowTitle>
              <RowDesc>
                {idx === 0
                  ? t("Shown first when this service has rated the title.")
                  : t("Used when no service above it has rated the title.")}
              </RowDesc>
            </RowText>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className={ROW_ACTION}
                aria-label={t("Move {name} up", { name: RATING_PROVIDER_LABELS[provider] })}
                disabled={idx === 0}
                onClick={() => move(provider, -1)}
              >
                <ChevronUp size={16} strokeWidth={2.2} />
              </button>
              <button
                type="button"
                className={ROW_ACTION}
                aria-label={t("Move {name} down", { name: RATING_PROVIDER_LABELS[provider] })}
                disabled={idx === order.length - 1}
                onClick={() => move(provider, 1)}
              >
                <ChevronDown size={16} strokeWidth={2.2} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
