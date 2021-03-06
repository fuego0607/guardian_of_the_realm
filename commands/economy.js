const args_js = require('../args.js');
const assets = require('../assets.js');
const utils = require('../utils.js');

/*
 * Buy some item in a quantity. titles only one, cant buy more or same
 * again.  <OBJECT> <AMOUNT>
 */
const buy = ({args, player_data, player_roles}) => {
  const command_return = {
    "reply": "",
    "update": {
      "player_data": {...player_data},
      "roles": {
        "player": {
          "add": [],
          "remove": []
        }
      }
    }
  };

  if(Array.isArray(args) && args.length) {
    // Get item and quanity. Default quantity is 1
    let item = args[0].toLowerCase();
    const quantity = args.length > 1
      ? parseInt(args[1], 10)
      : 1;

    let item_exists = item in assets.store_items;

    if(!item_exists && item in assets.game_roles) {
      [item] = assets.game_roles[item];
      item_exists = true;
    }

    // Ensure the desired item is in the store
    if(item_exists) {
      // Ensure we have a valid quanity value
      if(isNaN(quantity)) {
        command_return.reply = "Quantity to buy must be a number";
      } else {
        // Make sure the user has enough money for the item
        const total_cost = quantity * assets.store_items[item].cost;

        if(player_data.money >= total_cost) {
          // Good to buy!
          const item_type = assets.store_items[item].type;
          let deduct_cost = false;
          let item_requires = null;

          if("requires" in assets.store_items[item]) {
            item_requires = assets.store_items[item].requires;
          }

          // If this is a title type set the roles to adjust
          switch(item_type) {
            case "title":
            case "income":
              if(player_roles.includes(item)) {
                command_return.reply = `You already have the ${item} title`;
              } else if(item_requires &&
                !player_roles.includes(item_requires)) {
                command_return.reply = `The ${item} title requires the ` +
                  `${item_requires} title to buy`;
              } else {
                command_return.update.roles.player.add.push(item);

                if(item_requires) {
                  command_return.update.roles.player.remove.push(item_requires);
                }
                command_return.reply = `You successfully bought the ${item} ` +
                  `title for ${total_cost}`;
                deduct_cost = true;
              }
              break;
            case "men":
            case "ships":
              command_return.update.player_data[item_type] += quantity;
              command_return.reply = `You successfully bought ${quantity} ` +
                `${item} for ${total_cost}`;
              deduct_cost = true;
              break;
            default:
              command_return.reply = `Item type ${item_type} not ` +
                "supported. Please contact a bot dev.";
          }

          if(deduct_cost) {
            command_return.update.player_data.money -= total_cost;
          }
        } else {
          command_return.reply = "You do not have enough money to make " +
            "the purchase";
        }
      }
    } else {
      command_return.reply = `${item} is not a valid store item.`;
    }
  } else {
    command_return.reply = "buy requires at least 1 argument. usage: buy " +
      "<item> <quantity>";
  }

  return command_return;
};

/*
 * Request a loan of a given amount. must repay within 24 hours.
 * no more than 50% total money. random 5-50% interest. only one at a time.
 * .loan <GET|PAY|SHOW> <amount>
 */
const loan = ({args, player_data, loans}) => {
  const command_return = {
    "update": {
      "player_data": {...player_data}
    },
    "loans": {},
    "reply": ""
  };

  var [
    action,
    value
  ] = args;

  action = action.toLowerCase();

  if(action === 'get') {
    // See if player has a loan
    if(Array.isArray(loans) && loans.length) {
      command_return.reply = "You already have an outstanding loan";
    } else {
      // Ensure a value was specified and that it is valid
      const loan_amount = args.length === 2
        ? value
        : NaN;
      const max_loan_allowed = Math.floor(player_data.money / 2);

      if(isNaN(loan_amount) || loan_amount < 1) {
        command_return.reply = "Loan amount must be a positive number";
      } else if(player_data.money < 0) {
        command_return.reply = "You are in debt and may not buy a loan";
      } else if(loan_amount > max_loan_allowed) {
        command_return.reply = "The maximum loan amount you may get is " +
          `${max_loan_allowed}`;
      } else {
        // Good to go! Grant player loan amount. Determine interest
        const interest = utils.get_percent_of_value_given_range(
          loan_amount,
          5,
          50
        );
        command_return.update.player_data.money += loan_amount;
        command_return.loans.add = {
          "user": player_data.user,
          "amount_due": loan_amount + interest,
          "time_due": Date.now() + utils.hours_to_ms(24)
        };
        command_return.reply = "You successfully received a loan of " +
          `${loan_amount}. You have been charged ${interest} in interest. ` +
          "The loan is due in 24 hours";
      }
    }
  } else if(action === 'pay') {
    // See if player has a loan
    if(Array.isArray(loans) && loans.length) {
      const [loan_info] = loans;
      // Ensure a value was specified and that it is valid.
      let pay_amount = 0;

      // Adjust amount accordingly
      if(args.length === 2) {
        if(value === 'all') {
          pay_amount = loan_info.amount_due;
        } else {
          pay_amount = value;
          if(!isNaN(pay_amount)) {
            pay_amount = pay_amount > loan_info.amount_due
              ? loan_info.amount_due
              : pay_amount;
          }
        }
      }

      if(isNaN(pay_amount) || pay_amount < 1) {
        command_return.reply = "Pay amount must be a positive number";
      } else if(pay_amount > player_data.money) {
        command_return.reply = "You do not have enough money";
      } else {
        // Good to go! Adjust amount due. If paid off, delete the loan
        loan_info.amount_due -= pay_amount;

        if(loan_info.amount_due <= 0) {
          // Loan is paid! Delete it
          command_return.loans.remove = loan_info;
          command_return.reply = "You have paid off your loan!";
        } else {
          // Still have money due
          command_return.loans.update = loan_info;
          command_return.reply = `You paid ${pay_amount} toward your ` +
            `loan. You still owe ${loan_info.amount_due}`;
        }

        command_return.update.player_data.money -= pay_amount;
      }
    } else {
      command_return.reply = "You do not have an outstanding loan";
    }
  } else if(action === 'show') {
    if(Array.isArray(loans) && loans.length) {
      // Output loan info
      loans.forEach(this_loan => {
        const time_until_due = this_loan.time_due - Date.now();
        const due_string = time_until_due > 0
          ? "due in " + utils.get_time_until_string(time_until_due)
          : "past due";
        command_return.reply = `You owe ${this_loan.amount_due} on your ` +
          "loan. The loan is " + due_string;
      });
    } else {
      command_return.reply = "You do not have any loans";
    }
  } else {
    command_return.reply = `${action} is not a valid loan action`;
  }

  return command_return;
};

// Lists everything in the market they may buy
const market = () => {
  let titles_reply = "TITLES WILL EARN YOU MONEY EVERY DAY - BUY THEM ALL - " +
    "LIMIT ONE PER HOUSEHOLD:\n";
  let nobility_reply = "NOBILITY:\n";
  let warrior_reply = "WARRIOR:\n";

  for(var key in assets.store_items) {
    if(key in assets.store_items && 'cost' in assets.store_items[
      key] && 'flavor' in assets.store_items[
        key] && 'type' in assets.store_items[key]) {
      const item_cost = assets.store_items[key].cost;
      const item_flavor = assets.store_items[key].flavor;
      const item_type = assets.store_items[key].type;
      const key_cap = key[0].toUpperCase() + key.slice(1);
      const item_reply_text = `${key_cap}, ${item_cost} - ${item_flavor}\n`;
      if(item_type === "income") {
        titles_reply += item_reply_text;
      } else if(item_type === "title") {
        nobility_reply += item_reply_text;
      } else {
        warrior_reply += item_reply_text;
      }
    }
  }

  const reply = `${titles_reply}\n${nobility_reply}\n${warrior_reply}`;

  return {
    reply
  };
};

module.exports = {
  "dispatch": {
    "buy": {
      "function": buy,
      "args": [
        "args",
        "player_data",
        "player_roles"
      ],
      "command_args": [
        [args_js.arg_types.game_role],
        [
          args_js.arg_types.string,
          args_js.arg_types.number
        ]
      ],
      "usage": [
        "ROLE",
        "ITEM AMOUNT"
      ]
    },
    "loan": {
      "function": loan,
      "args": [
        "args",
        "player_data",
        "loans"
      ],
      "command_args": [
        [args_js.arg_types.string],
        [
          args_js.arg_types.string,
          args_js.arg_types.number
        ],
        [
          args_js.arg_types.string,
          args_js.arg_types.string
        ]
      ],
      "usage": [
        "show",
        "get AMOUNT",
        "pay AMOUNT|all"
      ]
    },
    "market": {
      "function": market,
      "args": [],
      "command_args": [[]],
      "usage": []
    }
  }
};
