from planner1.cli import _build_parser


def test_parser_minimum_args():
    args = _build_parser().parse_args(["42"])
    assert args.task_id == 42
    assert args.model == "claude-opus-4-7"
    assert args.safir_base_url is None


def test_parser_model_override():
    args = _build_parser().parse_args(["42", "--model", "claude-sonnet-4-6"])
    assert args.model == "claude-sonnet-4-6"


def test_parser_safir_base_url_override():
    args = _build_parser().parse_args(["42", "--safir-base-url", "http://safir.test:7000"])
    assert args.safir_base_url == "http://safir.test:7000"
