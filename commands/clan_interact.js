const assets = require('../assets.js');
const db = require('../database.js');
const utils = require('../utils.js');

/*
 * Assigns player to a house w/ default money and men
 * need merc role. lose it after
 * <HOUSE>
 */
const join = ({player_data, role_mention}) => {
  const command_return = {
    "update": {
      "player_data": {...player_data},
      "roles": {
        "add": []
      }
    },
    "reply": ""
  };

  // See if the player is in a house. If they are they cannot join another one
  if(player_data.house) {
    command_return.reply = "you are already part of a house";
  } else if(role_mention && assets.houses.includes(role_mention)) {
    // Add the player to the house
    command_return.update.player_data.house = role_mention;
    command_return.update.roles.add.push(role_mention);
    command_return.reply = `you successfully joined <@&${role_mention}>!`;
  } else {
    command_return.reply = "you must @ mention a house to join";
  }

  return command_return;
};

/*
 * Pledge men to a tile to attack/defend
 * <TILE> <NUMBER> [ATTACK|DEFEND]
 *
 * deduct the men from the player's count when the pledge is made
 */
const pledge = ({args, player_data}) => {
  const command_return = {
    "update": {
      "player_data": {...player_data}
    },
    "pledges": {},
    "reply": ""
  };

  // Check args
  if(Array.isArray(args) && args.length === 3) {
    // Validate args
    const selected_tile = args[0].toLowerCase();
    const num_men = parseInt(args[1], 10);
    const action = args[2].toLowerCase();

    const tile_owner = db.get_tile_owner.get(selected_tile);
    const p_men = player_data.men;

    if(!tile_owner) {
      command_return.reply = `${selected_tile} is not a castle`;
    } else if(isNaN(num_men) || num_men < 1) {
      command_return.reply = "number of men must be a positive number";
    } else if(num_men > p_men) {
      command_return.reply = `you do not have ${num_men} men`;
    } else if(action !== "attack" && action !== "defend") {
      command_return.reply = "action must be ATTACK or DEFEND";
    } else {
      // Ensure a siege exists on the tile
      const existing_siege = db.get_siege_on_tile.get(selected_tile);

      if(existing_siege) {
        // Add the pledge
        command_return.pledges.add = {
          "siege": existing_siege.siege_id,
          "user": player_data.user,
          "men": num_men,
          "choice": action
        };
        command_return.update.player_data.men -= num_men;
        command_return.reply = `you successfully pledged ${num_men} to ` +
          `${action} ${selected_tile}`;
      } else {
        command_return.reply = `there is no active siege on ${selected_tile}`;
      }
    }
  } else {
    command_return.reply = "usage: .pledge <tile> <num_men> [ATTACK|DEFEND]";
  }

  return command_return;
};

/*
 * Start a siege on a tile. must be with a house you are at war with
 * <TILE>
 *
 * Any player in a house may start a siege on a castle at any time.
 *
 * Lasts 6 hours.
 *
 * Winner chance is attacking / (attacking + defending).
 *
 * Resolution will occur when the siege time ends. All pledges will be counted
 * and included at the time. If a player made a pledge and does not have
 * that many troops the number of troops will be reduced to what they have
 * at the time the resolution occurs.
 *
 * Defender losses = attackers * (10-30%)
 * Attacker losses = defenders * (10-30%)
 *
 * Losses are proportional by pledge amount from each person, so
 * pledger / total attacker or defender.
 *
 * Winning house gets (or keeps) the castle.
 *
 * Winning cash pot of 6000 * num pledges, distributed proportionately
 * among the winners by pledge amount.
 *
 * Losing men pot of 20 * num pledges, distributed proportionately among
 * the losers by pledge amount.
 *
 */
const siege = ({args, player_data}) => {
  const command_return = {
    "sieges": {},
    "reply": ""
  };

  // Make sure the tile arg is correct
  if(Array.isArray(args) && args.length) {
    // Check tile
    const selected_tile = args[0].toLowerCase();
    const tile_owner = db.get_tile_owner.get(selected_tile);

    if(tile_owner) {
      // Tile is good. Make sure it is owned by a house at war with
      if(player_data.house === tile_owner.house) {
        command_return.reply = "your house owns this castle";
      } else {
        const war = db.get_war_between_houses.get({
          "house1": player_data.house,
          "house2": tile_owner.house
        });

        if(war) {
          // Make sure a siege does not already exist on this tile
          const existing_siege = db.get_siege_on_tile.get(selected_tile);

          if(existing_siege) {
            command_return.reply = "a siege is in progress on that castle";
          } else {
            // Good to go! Add the siege
            command_return.sieges.add = {
              "tile": selected_tile,
              "attacker": player_data.house,
              "time": Date.now() + utils.hours_to_ms(6)
            };

            command_return.reply = "you have initiated a siege on " +
              `<@&${tile_owner.house}>'s castle at ${selected_tile}`;
          }
        } else {
          command_return.reply = "your house is not at war with " +
            `<@&${tile_owner.house}>`;
        }
      }
    } else {
      command_return.reply = `${selected_tile} is not a castle`;
    }
  } else {
    command_return.reply = "you must specify a castle to attack, e.g. A10";
  }

  return command_return;
};

/*
 * Open a vote between two waring houses to stop the war. majority of each
 * house must agree <HOUSE> [YES|NO]
 *
 * When a player uses this command pull all current votes in the votes table
 * of type "truce" for all people in the player's house and the other house
 * in the truce vote. This is the set of all votes for the truce.
 *
 * Once the set is retrieved, see if the player already has a vote in place.
 * If the player has voted there is nothing for them to do. If the player does
 * not have a vote validate and record their vote in the pool.
 *
 * Before saving check to see if all players in both houses have voted on the
 * truce. If so, check the votes in both houses. See if at least half of both
 * houses agree on the truce. If so, remove the war. If not the war remains.
 *
 * After a vote finishes delete all the votes for the truce in the database.
 * Announce the outcome in channels.
 *
 * If a vote is not finished add the player's vote to the database.
 *
 * Vote also ends in a majority after 6 hours time.
 */
const truce = ({args, player_data, role_mention}) => {
  const command_return = {
    "votes": {},
    "reply": ""
  };

  // Check args. Make sure a war exists between the houses in question
  if(Array.isArray(args) && args.length === 2) {
    // Figure it out
    const house_vote = role_mention
      ? role_mention
      : utils.find_role_id_given_name(args[0], assets.game_roles);

    if(assets.houses.includes(house_vote)) {
      // See if the player has already voted for this
      const yes_votes = db.get_player_vote_by_type.all(
        player_data.user,
        "truce_yes"
      );
      const no_votes = db.get_player_vote_by_type.all(
        player_data.user,
        "truce_no"
      );
      const all_votes = yes_votes.concat(no_votes);

      const existing_vote = all_votes.filter(vote => vote &&
        'choice' in vote && vote.choice === house_vote);

      if(existing_vote.length) {
        // Already voted in this truce vote
        const [vote] = existing_vote;
        const choice = vote.type === "truce_yes"
          ? "YES"
          : "NO";

        command_return.reply = `you have already voted ${choice} to a truce ` +
          `with <@&${vote.choice}>`;
      } else {
        // Ensure a war exists between the houses
        const war = db.get_war_between_houses.get({
          "house1": player_data.house,
          "house2": house_vote
        });

        if(war) {
          // Check yes/no choice
          const player_choice = args[1].toLowerCase();
          let truce_type = "";

          if(player_choice === "yes") {
            truce_type = "truce_yes";
          } else if(player_choice === "no") {
            truce_type = "truce_no";
          }

          if(truce_type) {
            // Truce vote is good. Add it
            command_return.votes.add = {
              "type": truce_type,
              "user": player_data.user,
              "choice": house_vote,
              "time": Date.now()
            };
            command_return.reply = `your choice of ${player_choice} was ` +
              "recorded";
          } else {
            command_return.reply = "you must vote YES or NO";
          }
        } else {
          command_return.reply = "your house is not at war with " +
            `<@&${house_vote}>`;
        }
      }
    } else {
      command_return.reply = `${args[0]} is not a house`;
    }
  } else {
    command_return.reply = "you must @ the house to truce, use their name, " +
      "or use their Men at Arms and vote YES or NO";
  }

  return command_return;
};

/*
 * Start vote in house to begin a war. choose other houses, or no war.
 * majority wins [HOUSE|PEACE]
 *
 * When a player uses this command pull all current votes in the votes table
 * of type "war" for all people in the player's house. This is the set of
 * current war votes for the house (each house has at most 1 active war vote
 * at a time and last until all have voted).
 *
 * Once the set is retrieved, see if the player already has a vote in place.
 * If the player has voted there is nothing for them to do. If the player
 * does not have a vote see if their vote is for a house and, if so, whether
 * a war already exists between the player's house and the house they vote
 * on. If so, do nothing. If a war does not exist add the player's vote to
 * the vote pool.
 *
 * Before saving to the database see if all players in the house have voted.
 * If all players have voted determine the outcome of the vote, based on the
 * majority. Ties always lead to peace. If a war is the outcome add a new war
 * between the two houses.
 *
 * After a vote finishes delete all of the houses' votes in the database. If a
 * war was the result also delete all existing votes for the other house that
 * are against this house if they exist, allowing those players to choose a
 * different house to vote against. Annouce in channels about the new war.
 *
 * If a vote is not finished add the player's vote to the database.
 *
 * Vote also ends in a majority after 6 hours time.
 */
const war = ({args, player_data, role_mention}) => {
  const command_return = {
    "votes": {},
    "reply": ""
  };

  const existing_vote = db.get_player_vote_by_type.get(player_data.user, "war");

  if(existing_vote) {
    // Already has a vote
    const reply_choice = existing_vote.choice === "peace"
      ? "peace"
      : `<@&${existing_vote.choice}>`;
    command_return.reply = `you have already voted for ${reply_choice}`;
  } else if(Array.isArray(args) && args.length === 1) {
    // See what the arg is
    let player_choice = '';
    if(role_mention) {
      player_choice = role_mention;
    } else if(args[0].toLowerCase() === 'peace') {
      player_choice = 'peace';
    } else {
      player_choice = utils.find_role_id_given_name(
        args[0],
        assets.game_roles
      );
    }

    if(player_choice) {

      /*
       * Add the player's vote to the database
       * Ensure the player does not vote for their own house
       */
      if(player_choice === player_data.house) {
        command_return.reply = "you cannot vote for your own house";
      } else {
        command_return.votes.add = {
          "type": "war",
          "user": player_data.user,
          "choice": player_choice,
          "time": Date.now()
        };

        const reply_choice = player_choice === "peace"
          ? "peace"
          : `<@&${player_choice}>`;
        command_return.reply = "your choice of " + reply_choice +
          " was recorded";
      }
    } else {
      command_return.reply = "your choice is not recognized. Please vote " +
        "again";
    }
  } else {
    command_return.reply = "you must vote for a house or peace. To vote " +
      "for a house @ the house, use their name, or use their Men at Arms";
  }

  return command_return;
};

module.exports = {
  "dispatch": {
    "join": {
      "function": join,
      "args": [
        "player_data",
        "role_mention"
      ]
    },
    "pledge": {
      "function": pledge,
      "args": [
        "args",
        "player_data"
      ]
    },
    "siege": {
      "function": siege,
      "args": [
        "args",
        "player_data"
      ]
    },
    "truce": {
      "function": truce,
      "args": [
        "args",
        "player_data",
        "role_mention"
      ]
    },
    "war": {
      "function": war,
      "args": [
        "args",
        "player_data",
        "role_mention"
      ]
    }
  }
};
