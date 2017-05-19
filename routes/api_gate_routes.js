var express = require('express');
var router = express.Router({ mergeParams: true });
var _ = require('lodash');
var log = require('../libs/logger')(module);
var knex = require('../libs/db').knex;
var drupalSync = require('../scripts/drupal_ticket_sync');

var Ticket = require('../models/ticket').Ticket;
var Event = require('../models/event').Event;
var UsersGroup = require('../models/user').UsersGroup;

const ERRORS = {
    GATE_CODE_MISSING: 'gate_code is missing or incorrect',
    BAD_SEARCH_PARAMETERS: 'Search parameters are missing or incorrect. Please provide barcode or (ticket and order)',
    TICKET_NOT_FOUND: 'Ticket not found',
    ALREADY_INSIDE: 'Participant is already inside the event',
    QUOTA_REACHED: 'Users group quota reached',
    TICKET_NOT_IN_GROUP: 'Ticket is not assigned to this users group',
    USER_OUTSIDE_EVENT: 'Participant is outside of the event'
};

function sendError(res, httpCode, errorCode, errorObj) {
    if (errorObj) {
        log.error(errorObj)
    }
    return res.status(httpCode).json({
        error: errorCode,
        message: (errorObj && errorObj.message ? "Internal error: " + errorObj.message : ERRORS[errorCode])
    });
}

async function getTicketBySearchTerms(req, res) {

    // Loading event and checking that gate_code is valid.
    let event = null;
    let event_id = null;
    if (req.body.gate_code) {
        event = await Event.forge({ gate_code: req.body.gate_code }).fetch();
        event_id = event.attributes.event_id;
    }
    if (!req.body.gate_code || !event) {
        return sendError(res, 500, "GATE_CODE_MISSING");
    }

    // Setting the search terms for the ticket.
    let searchTerms;
    if (req.body.barcode) {
        searchTerms = { event_id: event_id, barcode: req.body.barcode };
    } else if (req.body.ticket && req.body.order) {
        searchTerms = { event_id: event_id, ticket_id: req.body.ticket, order_id: req.body.order };
    }
    else {
        return sendError(res, 500, "BAD_SEARCH_PARAMETERS");
    }

    // Loading data from the DB.
    var ticket = await Ticket.forge(searchTerms).fetch({ withRelated: ['holder'] });
    if (ticket) {
        return ticket;
    }
    else {
        return sendError(res, 404, "TICKET_NOT_FOUND");
    }
}

router.post('/get-ticket/', async function (req, res) {
    try {
        // Loading ticket data from the DB.
        let ticket = await getTicketBySearchTerms(req, res);

        if (!ticket) {
            return;
        }

        // Getting user groups.
        let groups = [];
        let groupsMembershipData = [];
        let holder = ticket.relations.holder;
        // await holder.fetch({withRelated: ['groups', 'groupsMembership']});
        await holder.fetch({ withRelated: ['groups'] });
        // if (holder.relations.groupsMembership) {
        //     _.each(holder.relations.groupsMembership.models, groupMembership => {
        //         if (groupMembership.attributes.status === 'approved' ||
        //             groupMembership.attributes.status === 'approved_mgr') {
        //             groupsMembershipData.push(groupMembership.attributes.group_id);
        //         }
        //     })
        // }
        if (holder.relations.groups) {
            _.each(holder.relations.groups.models, group => {
                // if (groupsMembershipData.contains(group.attributes.group_id)) {
                groups.push({
                    id: group.attributes.group_id,
                    type: group.attributes.type,
                    name: group.attributes.name
                });
                // }
            });
        }

        // Preparing result.
        let result = {
            ticket_number: ticket.attributes.ticket_number,
            holder_name: ticket.relations.holder.fullName,
            email: ticket.relations.holder.attributes.email,
            barcode: ticket.attributes.barcode,
            israeli_id: ticket.relations.holder.attributes.israeli_id,
            gender: ticket.relations.holder.attributes.gender,
            type: ticket.attributes.type,
            inside_event: ticket.attributes.inside_event,
            entrance_timestamp: ticket.attributes.entrance_timestamp ? ticket.attributes.entrance_timestamp.getTime() : null,
            first_entrance_timestamp: ticket.attributes.first_entrance_timestamp ? ticket.attributes.first_entrance_timestamp.getTime() : null,
            last_exit_timestamp: ticket.attributes.last_exit_timestamp ? ticket.attributes.last_exit_timestamp.getTime() : null,
            entrance_group_id: ticket.attributes.entrance_group_id,
            groups: groups
        };

        // All done, sending the result.
        res.status(200).json({
            ticket: result
        });
    }
    catch (err) {
        return sendError(res, 500, null, err);
    }
});

router.post('/gate-enter', async function (req, res) {

    // Loading ticket data from the DB.
    let ticket = await getTicketBySearchTerms(req, res)

    if (!ticket) {
        return sendError(res, 500, "TICKET_NOT_FOUND");
    }

    if (ticket.attributes.inside_event) {
        return sendError(res, 500, "ALREADY_INSIDE");
    }

    if (req.body.force) {
        log.warn(`forced ticket`);
    } else {
    // Finding the right users group and updating it.
        if (req.body.group_id) {
            let group = await UsersGroup.forge({ group_id: req.body.group_id }).fetch({ withRelated: ['users'] });

            if (!group) {
                return sendError(res, 500, "TICKET_NOT_IN_GROUP");
            }
            // console.log(group.users);
            // await holder.fetch({withRelated: ['groups']});

            // await group.getGroupUsers((users) => {
            //     console.log(users);
            //     console.log(group.users());
            // });
            // usersInsideEventsCounter: function () {
            //     let insideCounter = 0;
            //     let _users = this.relations.users;
            //     _.each(_users.models, (user) => {
            //         var foundTicket = 0;
            //         // console.log(user.tickets);
            //         // console.log(user.relations.tickets);
            //         // return;
            //         let _tickets=[];
            //         // let tickets = await Ticket.forge({ event_id: constants.CURRENT_EVENT_ID, holder_id: user.attributes.user_id }).fetch();
            //         // tickets=await Ticket.forge()
            //         _.each(_tickets, ticket => {
            //             if (ticket.attributs.inside_event) {
            //                 foundTicket = 1;
            //             }
            //         });
            //         insideCounter += foundTicket;
            //     });
            //     return insideCounter;
            // },
            // quotaReached: function () {
            //     this.usersInsideEventsCounter;
            //     return true;
            //     // return (this.usersInsideEventsCounter >= this.attributes.entrance_quota);
            // }
            let insideCounter = 0;
            let _users = group.relations.users;
            _.each(_users.models,async (user) => {
                var foundTicket = 0;
                console.log(user);
                // console.log(user.tickets);
                // console.log(user.relations.tickets);
                // return;
                // let _tickets = [];
                // let tickets = await Ticket.forge({ event_id: constants.CURRENT_EVENT_ID, holder_id: user.attributes.user_id }).fetch();
                // tickets=await Ticket.forge()
                let searchTerms = {
                    event_id: constants.CURRENT_EVENT_ID,
                    holder_id: user.attributes.user_id
                };
                let _tickets = await Ticket.forge(searchTerms).fetchAll({ withRelated: ['holder'] });
                console.log(_tickets);
                _.each(_tickets, ticket => {
                    if (ticket.attributs.inside_event) {
                        foundTicket = 1;
                    }
                });
                insideCounter += foundTicket;
            });
            if (insideCounter >= group.attributes.entrance_quota) {
                return sendError(res, 500, "QUOTA_REACHED");
            }
            console.log(insideCounter);

            // if (group.quotaReached) {
            // return sendError(res, 500, "QUOTA_REACHED");
            // }
        }
    }
    // Saving the entrance.
    ticket.attributes.entrance_timestamp = new Date();
    ticket.attributes.entrance_group_id = req.body.group_id || null;
    ticket.attributes.last_exit_timestamp = null;
    ticket.attributes.inside_event = true;
    if (!ticket.attributes.first_entrance_timestamp) {
        ticket.attributes.first_entrance_timestamp = new Date();
    }
    await ticket.save();

    // PATCH - Notifying Drupal that this ticket is now non-transferable. Remove with Drupal.
    drupalSync.passTicket(ticket.attributes.barcode);

    return res.status(200).json({
        message: "Ticket entered successfully"
    });
});

router.post('/gate-exit', async function (req, res) {

    try {
        let ticket = await getTicketBySearchTerms(req, res);

        if (!ticket) {
            return sendError(res, 500, "TICKET_NOT_FOUND");
        }

        if (!ticket.attributes.inside_event) {
            return sendError(res, 500, "USER_OUTSIDE_EVENT");
        }

        // Saving the exit.
        ticket.attributes.inside_event = false;
        ticket.attributes.entrance_group_id = null;
        ticket.attributes.entrance_timestamp = null;
        ticket.attributes.last_exit_timestamp = new Date();
        await ticket.save();

        return res.status(200).json({
            message: "Ticket exit completed"
        });
    }
    catch (err) {
        return sendError(res, 500, null, err)
    }
})
    ;

router.post('/tickets-counter', async function (req, res) {

    // Loading event and checking that gate_code is valid.
    let event_id = null;
    if (req.body.gate_code) {
        let event = await Event.forge({ gate_code: req.body.gate_code }).fetch();
        event_id = event.attributes.event_id;
    }
    if (!req.body.gate_code || !event_id) {
        return sendError(res, 500, "GATE_CODE_MISSING");
    }

    let count = await knex('tickets').count('inside_event').where('event_id', '=', event_id);
    return res.status(200).json(count);
});

module.exports = router;
