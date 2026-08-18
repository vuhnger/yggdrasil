import { v } from "convex/values";
import { internal } from "../../_generated/api";
import { Doc, Id } from "../../_generated/dataModel";
import { internalMutation, MutationCtx } from "../../_generated/server";

/**
 * Moves a registration to pending status and schedules the seat notification email.
 *
 * @param {MutationCtx} ctx - The Convex mutation context.
 * @param {Doc<"registrations">} registrationToMakePending - The registration to update.
 * @param {Doc<"events">} event - The event the registration belongs to.
 *
 * @throws - An error if the user for the registration cannot be resolved.
 * @returns {Promise<void>} - Resolves when the registration has been updated and the email scheduled.
 */
export const makeStatusPending = async (
    ctx: MutationCtx,
    registrationToMakePending: Doc<"registrations">,
    event: Doc<"events">,
) => {
    const user = await ctx.db.get(registrationToMakePending.userId);
    if (!user) {
        throw new Error(
            `Bruker med ID ${registrationToMakePending.userId} ikke funnet. Kan ikke oppdatere registrering.`,
        );
    }

    await ctx.db.patch(registrationToMakePending._id, {
        status: "pending",
        registrationTime: Date.now(),
    });

    await ctx.scheduler.runAfter(0, internal.emails.sendAvailableSeatEmail, {
        participantEmail: user.email,
        eventTitle: event.title,
        eventId: event._id,
        registrationId: registrationToMakePending._id,
    });
};

/**
 * Advances the event waitlist by a given number of places.
 *
 * @param {Id<"events">} eventId - The id of the event to update.
 * @param {number} numOfNewPlaces - The number of new places to offer.
 *
 * @returns {Promise<void>} - Resolves when the waitlist has been processed.
 */
export const updateWaitlistMutation = internalMutation({
    args: {
        eventId: v.id("events"),
        numOfNewPlaces: v.number(),
    },
    handler: async (ctx, { eventId, numOfNewPlaces }) => {
        await updateWaitlist(ctx, eventId, numOfNewPlaces);
    },
});

/**
 * Fetches an event's waitlisted registrations, oldest first.
 *
 * @param {MutationCtx} ctx - The Convex mutation context.
 * @param {Id<"events">} eventId - The id of the event to inspect.
 *
 * @returns {Promise<Doc<"registrations">[]>} - The waitlisted registrations, ordered oldest first.
 */
const getOrderedWaitlist = (ctx: MutationCtx, eventId: Id<"events">) =>
    ctx.db
        .query("registrations")
        .withIndex("by_eventIdStatusAndRegistrationTime", (q) =>
            q.eq("eventId", eventId).eq("status", "waitlist"),
        )
        .order("asc")
        .collect();

/**
 * Promotes waitlisted registrations into pending status.
 *
 * @param {MutationCtx} ctx - The Convex mutation context.
 * @param {Id<"events">} eventId - The id of the event to update.
 * @param {number} numOfNewPlaces - The number of new places to offer.
 *
 * @throws - An error if the event cannot be found.
 * @returns {Promise<void>} - Resolves when the waitlist has been updated.
 */
export const updateWaitlist = async (
    ctx: MutationCtx,
    eventId: Id<"events">,
    numOfNewPlaces: number,
) => {
    if (numOfNewPlaces <= 0) return;

    const event = await ctx.db.get(eventId);
    if (!event) {
        throw new Error(`Event not found for eventId: ${eventId}`);
    }

    const waitlistRegistrations = await getOrderedWaitlist(ctx, eventId);

    await Promise.all(
        waitlistRegistrations
            .slice(0, numOfNewPlaces)
            .map(async (registration) => await makeStatusPending(ctx, registration, event)),
    );
};

/**
 * Checks pending registrations and reoffers seats when the response window expires.
 *
 * @returns {Promise<void>} - Resolves when all pending registrations have been processed.
 */
export const checkPendingRegistrations = internalMutation({
    handler: async (ctx) => {
        const ONE_HOUR_MS = 60 * 60 * 1000;
        const ONE_MONTH_MS = 30 * 24 * ONE_HOUR_MS;
        const ANSWER_TIME_LIMIT_MS = 16 * ONE_HOUR_MS;

        const now = Date.now();

        // Get all event where we care if there are any pending registrations.
        // We only care about the one where registration is open and it is less than one hours since the event has started
        // This is to offset for the fact that the cron only runs every two hours.
        const eventsWithOpenRegistrations = await ctx.db
            .query("events")
            .withIndex("by_registrationOpens", (q) =>
                q
                    .gte("registrationOpens", now - ONE_MONTH_MS)
                    .lte("registrationOpens", now),
            )
            .filter((q) => q.gte(q.field("eventStart"), now - ONE_HOUR_MS))
            .filter((q) => q.eq(q.field("externalUrl"), ""))
            .filter((q) => q.eq(q.field("published"), true))
            .collect();

        // Get all the pending registrations.
        const pendingRegistrations = (
            await Promise.all(
                eventsWithOpenRegistrations.map(
                    async (event) =>
                        await ctx.db
                            .query("registrations")
                            .withIndex("by_eventIdStatusAndRegistrationTime", (q) =>
                                q.eq("eventId", event._id).eq("status", "pending"),
                            )
                            .order("asc")
                            .collect(),
                ),
            )
        ).flat();

        // Group the expired pending registrations by event, so each event's freed
        // seats are offered sequentially and never re-offered to a just-demoted registration.
        const expiredByEvent = new Map<Id<"events">, Doc<"registrations">[]>();
        for (const registration of pendingRegistrations) {
            if (now - registration.registrationTime > ANSWER_TIME_LIMIT_MS) {
                const expired = expiredByEvent.get(registration.eventId) ?? [];
                expired.push(registration);
                expiredByEvent.set(registration.eventId, expired);
            }
        }

        await Promise.all(
            Array.from(expiredByEvent.entries()).map(async ([eventId, expiredRegistrations]) => {
                const event = eventsWithOpenRegistrations.find((e) => e._id === eventId);
                if (!event) throw new Error("Ingen arrangement assosiert med registreringen.");

                // Move all expired registrations to the back of the waitlist.
                await Promise.all(
                    expiredRegistrations.map((registration) =>
                        ctx.db.patch(registration._id, {
                            status: "waitlist",
                            registrationTime: now,
                        }),
                    ),
                );

                const justDemoted = new Set(
                    expiredRegistrations.map((registration) => registration._id),
                );

                const waitlistCandidates = (await getOrderedWaitlist(ctx, eventId)).filter(
                    (registration) => !justDemoted.has(registration._id),
                );

                // Offer freed seats sequentially so each one goes to a distinct registration.
                for (const candidate of waitlistCandidates.slice(0, expiredRegistrations.length)) {
                    await makeStatusPending(ctx, candidate, event);
                }
            }),
        );
    },
});

/**
 * Clears waitlist and pending registrations for today's events and sends free-for-all emails.
 *
 * @returns {Promise<void>} - Resolves when the affected registrations have been cleared.
 */
export const clearWaitlistAndPending = internalMutation({
    handler: async (ctx) => {
        const now = Date.now();
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(now);
        endOfDay.setHours(23, 59, 59, 999);

        const eventsToClear = await ctx.db
            .query("events")
            .withIndex("by_eventStart", (q) =>
                q
                    .gte("eventStart", startOfDay.getTime())
                    .lte("eventStart", endOfDay.getTime()),
            )
            .collect();

        const registrationsForEvents = await Promise.all(
            eventsToClear.map(async (event) => {
                const registrations = await ctx.db
                    .query("registrations")
                    .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
                    .collect();

                return {
                    event,
                    registrations,
                };
            }),
        );

        await Promise.all(
            registrationsForEvents.map(async ({ event, registrations }) => {
                const availablePlaces =
                    event.participationLimit -
                    registrations.filter((reg) => reg.status === "registered").length;
                if (availablePlaces <= 0) return;

                // Delete and notify the students on the waitlist
                await Promise.all(
                    registrations
                        .filter((reg) => reg.status !== "registered")
                        .map(async (reg) => {
                            const user = await ctx.db.get(reg.userId);
                            if (!user) {
                                await ctx.db.delete(reg._id);
                                return;
                            }

                            // Notify registrant of the free-for all
                            await ctx.scheduler.runAfter(0, internal.emails.sendFreeForAll, {
                                participantEmail: user.email,
                                eventId: event._id,
                                eventTitle: event.title,
                                availableSeats: availablePlaces,
                            });

                            // Delete registrations
                            await ctx.db.delete(reg._id);
                        }),
                );
            }),
        );
    },
});

/**
 * Repairs the waitlist for an event by filling open spots with pending registrations.
 *
 * @param {Id<"events">} eventId - The id of the event to repair.
 *
 * @returns {Promise<"No event found" | void>} - A status message when no event is found, otherwise resolves after processing.
 */
export const fixWaitlist = internalMutation({
    args: {
        eventId: v.id("events"),
    },
    handler: async (ctx, { eventId }) => {
        const event = await ctx.db.get(eventId);
        if (!event) return "No event found";

        const registrations = await ctx.db
            .query("registrations")
            .withIndex("by_eventIdStatusAndRegistrationTime", (q) =>
                q.eq("eventId", eventId).eq("status", "registered"),
            )
            .collect();
        const pending = await ctx.db
            .query("registrations")
            .withIndex("by_eventIdStatusAndRegistrationTime", (q) =>
                q.eq("eventId", eventId).eq("status", "pending"),
            )
            .collect();

        console.log(
            registrations.length + pending.length,
            event.participationLimit,
        );

        const numRegisteredAndPending = registrations.length + pending.length;
        if (numRegisteredAndPending < event.participationLimit) {
            const waitlist = await ctx.db
                .query("registrations")
                .withIndex("by_eventIdStatusAndRegistrationTime", (q) =>
                    q.eq("eventId", eventId).eq("status", "waitlist"),
                )
                .collect();

            await Promise.all(
                waitlist
                    .slice(0, event.participationLimit - numRegisteredAndPending)
                    .map(async (reg) => {
                        await makeStatusPending(ctx, reg, event);
                    }),
            );
        }
    },
});
