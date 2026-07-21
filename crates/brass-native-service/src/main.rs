fn main() {
    if let Err(error) = brass_native_service::run_stdio() {
        eprintln!("brass-native-service: {error}");
        std::process::exit(1);
    }
}
