"""Flask webhook server for receiving GitLab events."""

import logging

from flask import Flask, jsonify, request

logger = logging.getLogger(__name__)

app = Flask(__name__)

# These will be set by start_webhook_server()
_config = None
_client = None
_state = None
_on_mr_event = None


@app.route("/webhook", methods=["POST"])
def webhook():
    """Receive GitLab webhook events."""
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "invalid JSON"}), 400

    object_kind = data.get("object_kind")
    event_type = data.get("event_type")

    logger.info(f"Received webhook: object_kind={object_kind}, event_type={event_type}")

    if object_kind == "merge_request":
        attributes = data.get("object_attributes", {})
        action = attributes.get("action")
        mr_iid = attributes.get("iid")

        if mr_iid and action in ("open", "update", "reopen"):
            logger.info(f"MR !{mr_iid} event: {action}")
            if _on_mr_event:
                _on_mr_event(mr_iid, action)
            return jsonify({"status": "accepted"}), 200

        logger.info(f"Ignoring MR event: action={action}")
        return jsonify({"status": "ignored"}), 200

    elif object_kind == "note":
        # V1: We don't process note events. The review-fix cycle is triggered by MR open/update.
        logger.info("Received note event (ignored in V1)")
        return jsonify({"status": "ignored"}), 200

    logger.info(f"Ignoring webhook: object_kind={object_kind}")
    return jsonify({"status": "ignored"}), 200


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


def start_webhook_server(port: int, config, client, state, on_mr_event):
    """Start the Flask webhook server with the given dependencies."""
    global _config, _client, _state, _on_mr_event
    _config = config
    _client = client
    _state = state
    _on_mr_event = on_mr_event

    logger.info(f"Starting webhook server on port {port}...")
    app.run(host="0.0.0.0", port=port, debug=False)
