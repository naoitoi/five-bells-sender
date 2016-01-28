'use strict'
const request = require('superagent')

/**
 * @param {[Transfer]} transfers
 * @param {Object} params
 * @param {Boolean} params.isAtomic
 * @param {Integer} params.now (for isAtomic=false)
 * @param {Integer} params.caseID (for isAtomic=true)
 * @param {Condition} params.executionCondition
 * @param {Condition} params.cancellationCondition (for isAtomic=true)
 */
export function setupTransfers (transfers, params) {
  const finalTransfer = transfers[transfers.length - 1]
  // Add conditions/expirations to all transfers.
  for (let transfer of transfers) {
    if (params.isAtomic) {
      transfer.execution_condition = params.executionCondition
      transfer.cancellation_condition = params.cancellationCondition
      transfer.additional_info.cases = [params.caseID]
      // Atomic transfers don't expire
      // (or rather, their expiry is handled by the cancellation_condition).
    } else {
      transfer.expires_at = transferExpiresAt(params.now, transfer)
      if (transfer !== finalTransfer) {
        transfer.execution_condition = params.executionCondition
      }
    }
    delete transfer.expiry_duration
  }

  // The first transfer must be submitted by us with authorization
  // TODO: This must be a genuine authorization from the user
  transfers[0].debits[0].authorized = true
}

/**
 * Propose + Prepare transfers
 * @param {[Transfer]} transfers
 * @param {Object} params
 * @param {String} params.sourceUsername
 * @param {String} params.sourcePassword
 * @returns {Promise}
 */
export async function postTransfers (transfers, params) {
  // TODO Theoretically we'd need to keep track of the signed responses
  // Prepare first transfer
  const firstTransfer = transfers[0]
  firstTransfer.state = await postTransfer(firstTransfer, {
    username: params.sourceUsername,
    password: params.sourcePassword
  })

  // Propose other transfers
  // TODO can these be done in parallel?
  for (let transfer of transfers.slice(1)) {
    // TODO: Also keep copy of state signature
    // Update transfer state
    transfer.state = await postTransfer(transfer)
  }
}

/**
 * @param {Transfer} transfer
 * @param {Object} auth (optional)
 * @param {String} auth.username
 * @param {String} auth.password
 * @returns {Promise<String>} the state of the transfer
 */
async function postTransfer (transfer, auth) {
  const transferReq = request.put(transfer.id).send(transfer)
  if (auth) {
    transferReq.auth(auth.username, auth.password)
  }
  const transferRes = await transferReq
  if (transferRes.status >= 400) {
    throw new Error('Remote error: ' + transferRes.status + ' ' + JSON.stringify(transferRes.body))
  }
  return transferRes.body.state
}

export function transferExpiresAt (now, transfer) {
  return (new Date(now + (transfer.expiry_duration * 1000))).toISOString()
}
